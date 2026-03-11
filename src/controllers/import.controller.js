'use strict';

const xlsx = require('xlsx');
const { Prisma } = require('@prisma/client');
const prisma = require('../lib/prisma');
const { sendSuccess, sendError } = require('../utils/response');
const logger = require('../config/logger');

const REQUIRED_COLUMNS = ['name', 'phone', 'plan_name', 'plan_amount', 'join_date', 'expiry_date'];
const MAX_FILE_ROWS = 5000;

function parseDate(value) {
  if (!value) return null;
  // xlsx may return a numeric serial date for Excel date cells
  if (typeof value === 'number') {
    const d = xlsx.SSF.parse_date_code(value);
    if (!d) return null;
    return new Date(d.y, d.m - 1, d.d);
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function parseFloatVal(value) {
  const n = parseFloat(value);
  return isNaN(n) ? null : n;
}

function validateRow(row, rowIndex) {
  const errors = [];

  const missing = REQUIRED_COLUMNS.filter((c) => !row[c] && row[c] !== 0);
  if (missing.length > 0) {
    return { valid: false, reason: `Missing required columns: ${missing.join(', ')}` };
  }

  const phone = String(row.phone).trim().replace(/\D/g, '');
  if (phone.length < 10) {
    errors.push('phone must be at least 10 digits');
  }

  const plan_amount = parseFloatVal(row.plan_amount);
  if (plan_amount === null || plan_amount < 0) {
    errors.push('plan_amount must be a positive number');
  }

  const join_date = parseDate(row.join_date);
  if (!join_date) errors.push('join_date is invalid');

  const expiry_date = parseDate(row.expiry_date);
  if (!expiry_date) errors.push('expiry_date is invalid');

  if (join_date && expiry_date && expiry_date < join_date) {
    errors.push('expiry_date must be on or after join_date');
  }

  if (errors.length > 0) {
    return { valid: false, reason: errors.join('; ') };
  }

  const plan_duration_days = Math.max(1, parseInt(row.plan_duration_days || '30', 10) || 30);

  return {
    valid: true,
    member: {
      name:              String(row.name).trim(),
      phone:             phone.slice(-10), // normalize to last 10 digits
      plan_name:         String(row.plan_name).trim(),
      plan_amount,
      plan_duration_days,
      join_date,
      expiry_date,
      status:            'active',
    },
  };
}

/**
 * POST /owner/members/import
 * Accepts multipart/form-data with field "file" (.xlsx / .xls / .csv)
 */
async function importMembers(req, res, next) {
  if (!req.file) {
    return sendError(res, 'No file uploaded. Send a .xlsx or .csv file in the "file" field.', 400);
  }

  const gymId = req.gymOwner.gym_id;

  try {
    // 1. Parse workbook from in-memory buffer
    let workbook;
    try {
      workbook = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: false });
    } catch {
      return sendError(res, 'Could not parse file. Please upload a valid .xlsx or .csv file.', 400);
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return sendError(res, 'File has no sheets.', 400);
    }

    // 2. Convert to JSON — headers from first row, normalized to snake_case
    const sheet = workbook.Sheets[sheetName];
    const rawRows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    if (rawRows.length === 0) {
      return sendError(res, 'File is empty or has no data rows.', 400);
    }

    if (rawRows.length > MAX_FILE_ROWS) {
      return sendError(res, `File has ${rawRows.length} rows. Maximum allowed is ${MAX_FILE_ROWS}.`, 400);
    }

    // Normalize headers: trim + lowercase + spaces→underscores
    const normalizedRows = rawRows.map((row) => {
      const normalized = {};
      for (const key of Object.keys(row)) {
        const normKey = key.trim().toLowerCase().replace(/\s+/g, '_');
        normalized[normKey] = row[key];
      }
      return normalized;
    });

    // 3. Check required columns exist in the file at all
    const fileKeys = Object.keys(normalizedRows[0] || {});
    const missingCols = REQUIRED_COLUMNS.filter((c) => !fileKeys.includes(c));
    if (missingCols.length > 0) {
      return sendError(
        res,
        `File is missing required columns: ${missingCols.join(', ')}. ` +
        `Required: ${REQUIRED_COLUMNS.join(', ')}`,
        400
      );
    }

    // 4. Validate each row
    const validMembers = [];
    const failedRows = [];

    normalizedRows.forEach((row, idx) => {
      const result = validateRow(row, idx);
      if (result.valid) {
        validMembers.push(result.member);
      } else {
        failedRows.push({ row: idx + 2, reason: result.reason }); // +2: 1 for header, 1 for 1-indexing
      }
    });

    if (validMembers.length === 0) {
      return sendSuccess(res, {
        imported: 0,
        total: normalizedRows.length,
        failed: failedRows,
      }, 'No valid rows to import.');
    }

    // 5. Upsert valid rows in a single transaction (batch by phone uniqueness)
    const phones = validMembers.map((m) => m.phone);
    const existing = await prisma.member.findMany({
      where: { gym_id: gymId, phone: { in: phones } },
      select: { id: true, phone: true },
    });
    const existingMap = new Map(existing.map((m) => [m.phone, m.id]));

    const toCreate = [];
    const toUpdate = [];

    for (const member of validMembers) {
      const existingId = existingMap.get(member.phone);
      if (existingId) {
        toUpdate.push({ id: existingId, data: member });
      } else {
        toCreate.push({ gym_id: gymId, ...member });
      }
    }

    let imported = 0;

    // Batch create
    if (toCreate.length > 0) {
      const result = await prisma.member.createMany({
        data: toCreate,
        skipDuplicates: true,
      });
      imported += result.count;
    }

    // Batch update (single SQL CASE WHEN)
    if (toUpdate.length > 0) {
      const planNameFrags  = toUpdate.map(u => Prisma.sql`WHEN ${u.id} THEN ${u.data.plan_name}`);
      const amountFrags    = toUpdate.map(u => Prisma.sql`WHEN ${u.id} THEN ${u.data.plan_amount}`);
      const daysFrags      = toUpdate.map(u => Prisma.sql`WHEN ${u.id} THEN ${u.data.plan_duration_days}`);
      const joinFrags      = toUpdate.map(u => Prisma.sql`WHEN ${u.id} THEN ${u.data.join_date}`);
      const expiryFrags    = toUpdate.map(u => Prisma.sql`WHEN ${u.id} THEN ${u.data.expiry_date}`);
      const nameFrags      = toUpdate.map(u => Prisma.sql`WHEN ${u.id} THEN ${u.data.name}`);
      const ids            = toUpdate.map(u => u.id);

      await prisma.$executeRaw(Prisma.sql`
        UPDATE Member SET
          name               = CASE id ${Prisma.join(nameFrags,     ' ')} END,
          plan_name          = CASE id ${Prisma.join(planNameFrags, ' ')} END,
          plan_amount        = CASE id ${Prisma.join(amountFrags,   ' ')} END,
          plan_duration_days = CASE id ${Prisma.join(daysFrags,     ' ')} END,
          join_date          = CASE id ${Prisma.join(joinFrags,     ' ')} END,
          expiry_date        = CASE id ${Prisma.join(expiryFrags,   ' ')} END,
          status             = 'active',
          deleted_at         = NULL
        WHERE id IN (${Prisma.join(ids)}) AND gym_id = ${gymId}
      `);
      imported += toUpdate.length;
    }

    logger.info('[importMembers] Import complete', {
      gym_id: gymId,
      total: normalizedRows.length,
      imported,
      failed: failedRows.length,
    });

    return sendSuccess(res, {
      imported,
      total:  normalizedRows.length,
      failed: failedRows,
    }, `Import complete. ${imported} members imported, ${failedRows.length} rows failed.`);

  } catch (err) {
    next(err);
  }
}

/**
 * POST /owner/members/import/bulk
 * Accepts pre-mapped, pre-validated JSON rows from the frontend wizard.
 * Body: { members: [{ name, phone, plan_name, plan_amount, join_date, expiry_date, plan_duration_days? }] }
 */
async function bulkImportMembers(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const { members: rawMembers } = req.body;

  if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
    return sendError(res, 'No members data provided.', 400);
  }
  if (rawMembers.length > 5000) {
    return sendError(res, 'Maximum 5000 rows per import.', 400);
  }

  try {
    // Validate each row
    const validMembers = [];
    const failedRows   = [];

    rawMembers.forEach((row, idx) => {
      const result = validateRow(row, idx);
      if (result.valid) {
        validMembers.push(result.member);
      } else {
        failedRows.push({ row: idx + 1, name: row.name || '', phone: row.phone || '', reason: result.reason });
      }
    });

    if (validMembers.length === 0) {
      return sendSuccess(res, { imported: 0, total: rawMembers.length, failed: failedRows }, 'No valid rows to import.');
    }

    // Upsert valid rows
    const phones      = validMembers.map((m) => m.phone);
    const existing    = await prisma.member.findMany({
      where: { gym_id: gymId, phone: { in: phones } },
      select: { id: true, phone: true },
    });
    const existingMap = new Map(existing.map((m) => [m.phone, m.id]));

    const toCreate = [];
    const toUpdate = [];
    for (const member of validMembers) {
      const existingId = existingMap.get(member.phone);
      if (existingId) toUpdate.push({ id: existingId, data: member });
      else            toCreate.push({ gym_id: gymId, ...member });
    }

    let imported = 0;

    if (toCreate.length > 0) {
      const r = await prisma.member.createMany({ data: toCreate, skipDuplicates: true });
      imported += r.count;
    }

    if (toUpdate.length > 0) {
      const planNameFrags = toUpdate.map(u => Prisma.sql`WHEN ${u.id} THEN ${u.data.plan_name}`);
      const amountFrags   = toUpdate.map(u => Prisma.sql`WHEN ${u.id} THEN ${u.data.plan_amount}`);
      const daysFrags     = toUpdate.map(u => Prisma.sql`WHEN ${u.id} THEN ${u.data.plan_duration_days}`);
      const joinFrags     = toUpdate.map(u => Prisma.sql`WHEN ${u.id} THEN ${u.data.join_date}`);
      const expiryFrags   = toUpdate.map(u => Prisma.sql`WHEN ${u.id} THEN ${u.data.expiry_date}`);
      const nameFrags     = toUpdate.map(u => Prisma.sql`WHEN ${u.id} THEN ${u.data.name}`);
      const ids           = toUpdate.map(u => u.id);

      await prisma.$executeRaw(Prisma.sql`
        UPDATE Member SET
          name               = CASE id ${Prisma.join(nameFrags,     ' ')} END,
          plan_name          = CASE id ${Prisma.join(planNameFrags, ' ')} END,
          plan_amount        = CASE id ${Prisma.join(amountFrags,   ' ')} END,
          plan_duration_days = CASE id ${Prisma.join(daysFrags,     ' ')} END,
          join_date          = CASE id ${Prisma.join(joinFrags,     ' ')} END,
          expiry_date        = CASE id ${Prisma.join(expiryFrags,   ' ')} END,
          status             = 'active',
          deleted_at         = NULL
        WHERE id IN (${Prisma.join(ids)}) AND gym_id = ${gymId}
      `);
      imported += toUpdate.length;
    }

    logger.info('[bulkImportMembers] Import complete', { gym_id: gymId, total: rawMembers.length, imported, failed: failedRows.length });

    return sendSuccess(res, {
      imported,
      total:  rawMembers.length,
      failed: failedRows,
    }, `Import complete. ${imported} members imported, ${failedRows.length} rows failed.`);

  } catch (err) {
    next(err);
  }
}

module.exports = { importMembers, bulkImportMembers };
