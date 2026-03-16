'use strict';

const prisma = require('../lib/prisma');

/** "YYYY-MM" from any Date-like value */
function monthKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Whole-month difference between two dates (floor) */
function diffMonths(joinDate, laterDate) {
  const j = new Date(joinDate);
  const l = new Date(laterDate);
  return (l.getFullYear() - j.getFullYear()) * 12 + (l.getMonth() - j.getMonth());
}

/**
 * Returns a cohort retention matrix for a gym.
 *
 * Each cohort is the calendar month in which members joined.
 * For each subsequent month offset (0–12) the entry shows how many members
 * in that cohort made at least one paid renewal during that month.
 *
 * Shape:
 * [
 *   {
 *     cohort_month: "2025-01",
 *     size: 20,
 *     months: [
 *       { month: 0, count: 18, pct: 90 },
 *       { month: 1, count: 14, pct: 70 },
 *       ...up to month 12
 *     ]
 *   },
 *   ...
 * ]
 *
 * @param {number} gymId
 * @returns {Promise<Array>}
 */
async function getMemberCohorts(gymId) {
  const members = await prisma.member.findMany({
    where: { gym_id: gymId, deleted_at: null },
    select: { id: true, join_date: true },
  });

  const renewals = await prisma.renewal.findMany({
    where: { gym_id: gymId, status: 'paid' },
    select: { member_id: true, created_at: true },
  });

  // member_id → join_date
  const joinMap = new Map(members.map((m) => [m.id, m.join_date]));

  // cohort_month → Set<member_id>
  const cohortMembers = new Map();
  for (const m of members) {
    const key = monthKey(m.join_date);
    if (!cohortMembers.has(key)) cohortMembers.set(key, new Set());
    cohortMembers.get(key).add(m.id);
  }

  // cohort_month → month_offset → Set<member_id who renewed that month>
  const cohortActivity = new Map();
  for (const r of renewals) {
    const joinDate = joinMap.get(r.member_id);
    if (!joinDate) continue;
    const offset = diffMonths(joinDate, r.created_at);
    if (offset < 0 || offset > 12) continue;
    const cKey = monthKey(joinDate);
    if (!cohortActivity.has(cKey)) cohortActivity.set(cKey, new Map());
    const offMap = cohortActivity.get(cKey);
    if (!offMap.has(offset)) offMap.set(offset, new Set());
    offMap.get(offset).add(r.member_id);
  }

  const sortedKeys = [...cohortMembers.keys()].sort();
  return sortedKeys.map((cohortMonth) => {
    const memberSet = cohortMembers.get(cohortMonth);
    const size = memberSet.size;
    const offMap = cohortActivity.get(cohortMonth) || new Map();

    const months = [];
    for (let mo = 0; mo <= 12; mo++) {
      const renewedSet = offMap.get(mo) || new Set();
      // Only count members who actually belong to this cohort
      const count = [...renewedSet].filter((id) => memberSet.has(id)).length;
      months.push({
        month: mo,
        count,
        pct: size > 0 ? Math.round((count / size) * 100) : 0,
      });
    }

    return { cohort_month: cohortMonth, size, months };
  });
}

/**
 * Returns a retention curve showing what fraction of members renewed
 * at each month milestone (1, 2, 3, 6, 9, 12 months after joining).
 *
 * A member is counted as "retained at month N" if they have at least one
 * paid renewal with a month offset in [1..N].
 *
 * Shape:
 * {
 *   total_members: 120,
 *   curve: [
 *     { month: 1,  retained_count: 90,  retention_rate: 0.75 },
 *     { month: 3,  retained_count: 60,  retention_rate: 0.50 },
 *     ...
 *   ]
 * }
 *
 * @param {number} gymId
 * @returns {Promise<object>}
 */
async function getRetentionCurve(gymId) {
  const members = await prisma.member.findMany({
    where: { gym_id: gymId, deleted_at: null },
    select: { id: true, join_date: true },
  });

  const renewals = await prisma.renewal.findMany({
    where: { gym_id: gymId, status: 'paid' },
    select: { member_id: true, created_at: true },
  });

  const joinMap = new Map(members.map((m) => [m.id, m.join_date]));

  // member_id → Set<month_offsets of paid renewals>
  const memberOffsets = new Map();
  for (const r of renewals) {
    const joinDate = joinMap.get(r.member_id);
    if (!joinDate) continue;
    const offset = diffMonths(joinDate, r.created_at);
    if (offset < 1) continue; // month 0 = same month as join, not a renewal
    if (!memberOffsets.has(r.member_id)) memberOffsets.set(r.member_id, new Set());
    memberOffsets.get(r.member_id).add(offset);
  }

  const totalMembers = members.length;
  const MILESTONES = [1, 2, 3, 6, 9, 12];

  const curve = MILESTONES.map((milestone) => {
    const retained = members.filter((m) => {
      const offsets = memberOffsets.get(m.id);
      if (!offsets) return false;
      return [...offsets].some((mo) => mo >= 1 && mo <= milestone);
    }).length;

    return {
      month: milestone,
      retained_count: retained,
      retention_rate: totalMembers > 0
        ? Math.round((retained / totalMembers) * 1000) / 1000
        : 0,
    };
  });

  return { total_members: totalMembers, curve };
}

module.exports = { getMemberCohorts, getRetentionCurve };
