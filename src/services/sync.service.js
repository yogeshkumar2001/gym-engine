'use strict';

const prisma = require('../lib/prisma');
const { getSheetRows } = require('./googleSheetService');
const logger = require('../config/logger');

// Required columns (lowercase, trimmed)
const REQUIRED_COLUMNS = ['name', 'phone', 'plan_name', 'plan_amount', 'join_date', 'expiry_date'];

// Safety threshold: abort deactivation if removed members exceed this fraction of active members.
const DEACTIVATION_SAFETY_THRESHOLD = 0.5;

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
  // 1. Fetch gym — only the fields we actually use.
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { id: true, google_sheet_id: true },
  });
  if (!gym) return null; // caller handles 404

  // 2. Fetch sheet rows (external API call).
  const rows = await getSheetRows(gym.google_sheet_id);

  if (rows.length < 2) {
    // Empty sheet or header-only — skip to avoid accidental mass-deactivation.
    logger.warn(`[syncGymMembers] gym_id=${gymId}: sheet has ${rows.length} row(s) — skipping sync.`);
    return { totalRows: 0, inserted: 0, updated: 0, skipped: 0, deactivated: 0 };
  }

  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const dataRows = rows.slice(1);

  // 3. Fetch ALL existing members for this gym in one query and index by phone.
  const existingMembers = await prisma.member.findMany({
    where: { gym_id: gymId },
    select: { id: true, phone: true, status: true },
  });
  const existingMap = new Map(existingMembers.map((m) => [m.phone, m]));

  // 4. Parse and validate every sheet row, splitting into create / update buckets.
  //    Track sheetPhones to detect removed members. No DB calls inside this loop.
  const toCreate = [];
  const toUpdate = [];
  const sheetPhones = new Set();
  let skipped = 0;

  for (const row of dataRows) {
    const mapped = mapRowToMember(headers, row);

    // Validate required fields present.
    const missing = REQUIRED_COLUMNS.filter((c) => !mapped[c]);
    if (missing.length > 0) {
      logger.debug(`[syncGymMembers] Skipping row — missing: ${missing.join(', ')}`);
      skipped++;
      continue;
    }

    const join_date   = parseDate(mapped.join_date);
    const expiry_date = parseDate(mapped.expiry_date);
    const plan_amount = parseFloat_(mapped.plan_amount);

    if (!join_date || !expiry_date || plan_amount === null) {
      logger.debug(`[syncGymMembers] Skipping row "${mapped.name}" — invalid date or amount`);
      skipped++;
      continue;
    }

    // plan_duration_days is optional; default to 30 if absent or invalid.
    const plan_duration_days = Math.max(1, parseInt(mapped.plan_duration_days || '30', 10) || 30);

    // Track every valid phone seen in the sheet.
    sheetPhones.add(mapped.phone);

    const existing = existingMap.get(mapped.phone);

    if (existing) {
      // Existing member — sync sheet-controlled fields.
      // Also re-activates members that were auto-deactivated but have returned to the sheet.
      toUpdate.push({
        id: existing.id,
        data: {
          plan_name:         mapped.plan_name,
          plan_amount,
          plan_duration_days,
          expiry_date,
          status:            'active', // re-activate if previously deactivated
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

  // 5. Compute members to deactivate: active members whose phone is no longer in the sheet.
  const toDeactivate = existingMembers.filter(
    (m) => m.status === 'active' && !sheetPhones.has(m.phone)
  );

  const activeCount = existingMembers.filter((m) => m.status === 'active').length;

  // Safety guard: abort deactivation if it would affect more than 50% of active members.
  // This prevents a misconfigured or corrupted sheet from mass-deactivating real members.
  if (toDeactivate.length > 0 && toDeactivate.length > activeCount * DEACTIVATION_SAFETY_THRESHOLD) {
    logger.warn(
      `[syncGymMembers] gym_id=${gymId}: DEACTIVATION ABORTED — ` +
      `would deactivate ${toDeactivate.length}/${activeCount} active members (>${DEACTIVATION_SAFETY_THRESHOLD * 100}%). ` +
      `Manual review required. Proceeding with inserts/updates only.`
    );
    // Still execute creates and updates — only deactivation is blocked.
  }

  // 6. Execute create batch.
  let inserted = 0;
  if (toCreate.length > 0) {
    const result = await prisma.member.createMany({
      data: toCreate,
      skipDuplicates: true,
    });
    inserted = result.count;
  }

  // 7. Execute update batch inside a single transaction.
  let updated = 0;
  if (toUpdate.length > 0) {
    await prisma.$transaction(
      toUpdate.map(({ id, data }) => prisma.member.update({ where: { id }, data }))
    );
    updated = toUpdate.length;
  }

  // 8. Execute deactivation (only if safety check passed).
  let deactivated = 0;
  const safeToDeactivate =
    toDeactivate.length === 0 ||
    toDeactivate.length <= activeCount * DEACTIVATION_SAFETY_THRESHOLD;

  if (safeToDeactivate && toDeactivate.length > 0) {
    const deactivateIds = toDeactivate.map((m) => m.id);
    await prisma.member.updateMany({
      where: { id: { in: deactivateIds } },
      data: { status: 'inactive' },
    });
    deactivated = toDeactivate.length;
  }

  const stats = { totalRows: dataRows.length, inserted, updated, skipped, deactivated };
  logger.info(`[syncGymMembers] gym_id=${gymId} complete: ${JSON.stringify(stats)}`);
  return stats;
}

module.exports = { syncGymMembers };
