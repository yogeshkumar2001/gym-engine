'use strict';

const prisma = require('../lib/prisma');
const { getSheetRows } = require('./googleSheetService');
const logger = require('../config/logger');

// Required columns (lowercase, trimmed)
const REQUIRED_COLUMNS = ['name', 'phone', 'plan_name', 'plan_amount', 'join_date', 'expiry_date'];

function parseDate(value) {
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function parseFloat_(value) {
  const n = parseFloat(value);
  return isNaN(n) ? null : n;
}

function mapRowToMember(headers, row) {
  const obj = {};
  headers.forEach((h, i) => {
    obj[h.trim().toLowerCase()] = (row[i] || '').toString().trim();
  });
  return obj;
}

async function syncGymMembers(gymId) {
  // 1. Fetch gym — only the field we actually use.
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { id: true, google_sheet_id: true },
  });
  if (!gym) return null; // caller handles 404

  // 2. Fetch sheet rows (external API call).
  const rows = await getSheetRows(gym.google_sheet_id);

  if (rows.length < 2) {
    // Empty sheet or header-only — nothing to sync.
    return { totalRows: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const dataRows = rows.slice(1);

  // 3. Fetch ALL existing members for this gym in one query and index by phone.
  //    Replaces the per-row findUnique that caused the N+1 pattern.
  const existingMembers = await prisma.member.findMany({
    where: { gym_id: gymId },
    select: { id: true, phone: true },
  });
  const existingMap = new Map(existingMembers.map((m) => [m.phone, m]));

  // 4. Parse and validate every sheet row, splitting into create / update buckets.
  //    No DB calls inside this loop.
  const toCreate = [];
  const toUpdate = [];
  let skipped = 0;

  for (const row of dataRows) {
    const mapped = mapRowToMember(headers, row);

    // Validate required fields present.
    const missing = REQUIRED_COLUMNS.filter((c) => !mapped[c]);
    if (missing.length > 0) {
      logger.debug(`Skipping row — missing: ${missing.join(', ')}`);
      skipped++;
      continue;
    }

    const join_date    = parseDate(mapped.join_date);
    const expiry_date  = parseDate(mapped.expiry_date);
    const plan_amount  = parseFloat_(mapped.plan_amount);

    if (!join_date || !expiry_date || plan_amount === null) {
      logger.debug(`Skipping row "${mapped.name}" — invalid date or amount`);
      skipped++;
      continue;
    }

    // plan_duration_days is optional in the sheet; default to 30 if absent or invalid.
    const plan_duration_days = Math.max(1, parseInt(mapped.plan_duration_days || '30', 10) || 30);

    const existing = existingMap.get(mapped.phone);

    if (existing) {
      // Existing member — queue an update for the same fields the upsert updated.
      // name, phone, join_date, and status are intentionally not modified on re-sync.
      toUpdate.push({
        id: existing.id,
        data: {
          plan_name:          mapped.plan_name,
          plan_amount,
          plan_duration_days,
          expiry_date,
        },
      });
    } else {
      // New member — queue a create.
      toCreate.push({
        gym_id: gymId,
        name: mapped.name,
        phone: mapped.phone,
        plan_name: mapped.plan_name,
        plan_amount,
        plan_duration_days,
        join_date,
        expiry_date,
      });
    }
  }

  // 5. Execute both batches — each is a single DB round-trip regardless of batch size.

  let inserted = 0;
  if (toCreate.length > 0) {
    // skipDuplicates guards against duplicate phone numbers within the same sheet.
    // Without it a second occurrence of the same phone would throw P2002.
    // result.count reflects only rows actually inserted, so the stat is accurate.
    const result = await prisma.member.createMany({
      data: toCreate,
      skipDuplicates: true,
    });
    inserted = result.count;
  }

  let updated = 0;
  if (toUpdate.length > 0) {
    // All updates run inside a single transaction — one BEGIN / COMMIT regardless
    // of how many members are being updated.
    await prisma.$transaction(
      toUpdate.map(({ id, data }) => prisma.member.update({ where: { id }, data }))
    );
    updated = toUpdate.length;
  }

  const stats = { totalRows: dataRows.length, inserted, updated, skipped };
  logger.info(`Sync complete for gym ${gymId}: ${JSON.stringify(stats)}`);
  return stats;
}

module.exports = { syncGymMembers };
