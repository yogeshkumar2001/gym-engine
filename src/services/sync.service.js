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
  // 1. Fetch gym
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym) return null; // caller handles 404

  // 2. Fetch sheet rows
  const rows = await getSheetRows(gym.google_sheet_id);

  const stats = { totalRows: 0, inserted: 0, updated: 0, skipped: 0 };

  if (rows.length < 2) {
    // Empty sheet or header-only — nothing to sync
    return { totalRows: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const dataRows = rows.slice(1);
  stats.totalRows = dataRows.length;

  for (const row of dataRows) {
    const mapped = mapRowToMember(headers, row);

    // Validate required fields present
    const missing = REQUIRED_COLUMNS.filter((c) => !mapped[c]);
    if (missing.length > 0) {
      logger.debug(`Skipping row — missing: ${missing.join(', ')}`);
      stats.skipped++;
      continue;
    }

    const join_date = parseDate(mapped.join_date);
    const expiry_date = parseDate(mapped.expiry_date);
    const plan_amount = parseFloat_(mapped.plan_amount);

    if (!join_date || !expiry_date || plan_amount === null) {
      logger.debug(`Skipping row "${mapped.name}" — invalid date or amount`);
      stats.skipped++;
      continue;
    }

    const createData = {
      gym_id: gymId,
      name: mapped.name,
      phone: mapped.phone,
      plan_name: mapped.plan_name,
      plan_amount,
      join_date,
      expiry_date,
    };

    const existing = await prisma.member.findUnique({
      where: { gym_id_phone: { gym_id: gymId, phone: mapped.phone } },
      select: { id: true },
    });

    await prisma.member.upsert({
      where: { gym_id_phone: { gym_id: gymId, phone: mapped.phone } },
      update: {
        plan_name: mapped.plan_name,
        plan_amount,
        expiry_date,
      },
      create: createData,
    });

    if (existing) {
      stats.updated++;
    } else {
      stats.inserted++;
    }
  }

  logger.info(`Sync complete for gym ${gymId}: ${JSON.stringify(stats)}`);
  return stats;
}

module.exports = { syncGymMembers };
