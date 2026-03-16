'use strict';

const prisma = require('../lib/prisma');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * POST /owner/members/:memberId/checkin
 * Records a new check-in. Rejects if the member is already checked in today.
 */
async function checkIn(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const memberId = parseInt(req.params.memberId, 10);
  if (!memberId) return sendError(res, 'Invalid memberId.', 400);

  try {
    const member = await prisma.member.findFirst({
      where: { id: memberId, gym_id: gymId, deleted_at: null },
      select: { id: true, name: true, status: true },
    });
    if (!member) return sendError(res, 'Member not found.', 404);
    if (member.status !== 'active') return sendError(res, 'Member is not active.', 400);

    // Prevent duplicate open check-ins on the same day
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const existing = await prisma.attendance.findFirst({
      where: {
        member_id: memberId,
        gym_id: gymId,
        checked_in_at: { gte: startOfToday },
        checked_out_at: null,
      },
    });
    if (existing) return sendError(res, 'Member is already checked in.', 409);

    const record = await prisma.attendance.create({
      data: { gym_id: gymId, member_id: memberId },
      include: { member: { select: { id: true, name: true, phone: true } } },
    });

    return sendSuccess(res, record, 'Check-in recorded.');
  } catch (err) {
    next(err);
  }
}

/**
 * POST /owner/members/:memberId/checkout
 * Closes the latest open attendance record for this member.
 */
async function checkOut(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const memberId = parseInt(req.params.memberId, 10);
  if (!memberId) return sendError(res, 'Invalid memberId.', 400);

  try {
    const record = await prisma.attendance.findFirst({
      where: { member_id: memberId, gym_id: gymId, checked_out_at: null },
      orderBy: { checked_in_at: 'desc' },
    });
    if (!record) return sendError(res, 'No active check-in found for this member.', 404);

    const updated = await prisma.attendance.update({
      where: { id: record.id },
      data: { checked_out_at: new Date() },
      include: { member: { select: { id: true, name: true, phone: true } } },
    });

    return sendSuccess(res, updated, 'Check-out recorded.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /owner/attendance
 * Lists attendance records with optional filters.
 *
 * Query params:
 *   page     (default 1)
 *   limit    (default 50, max 200)
 *   member_id
 *   date     (ISO date string — filters to that calendar day)
 */
async function listAttendance(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const skip = (page - 1) * limit;

  const where = { gym_id: gymId };

  if (req.query.member_id) {
    where.member_id = parseInt(req.query.member_id, 10);
  }

  if (req.query.date) {
    const d = new Date(req.query.date);
    if (!isNaN(d.getTime())) {
      d.setHours(0, 0, 0, 0);
      const nextDay = new Date(d.getTime() + 24 * 60 * 60 * 1000);
      where.checked_in_at = { gte: d, lt: nextDay };
    }
  }

  try {
    const [records, total] = await Promise.all([
      prisma.attendance.findMany({
        where,
        orderBy: { checked_in_at: 'desc' },
        skip,
        take: limit,
        include: {
          member: { select: { id: true, name: true, phone: true } },
        },
      }),
      prisma.attendance.count({ where }),
    ]);

    return sendSuccess(res, { records, total, page, limit }, 'Attendance list retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /owner/attendance/stats
 * Returns today / week / month visit counts, peak hours, and top members.
 */
async function getAttendanceStats(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const now = new Date();

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  try {
    const todayCount = await prisma.attendance.count({
      where: { gym_id: gymId, checked_in_at: { gte: startOfToday } },
    });

    const weekCount = await prisma.attendance.count({
      where: { gym_id: gymId, checked_in_at: { gte: startOfWeek } },
    });

    const monthCount = await prisma.attendance.count({
      where: { gym_id: gymId, checked_in_at: { gte: startOfMonth } },
    });

    // Peak hours: check-ins in the last 30 days grouped by hour
    const recentCheckins = await prisma.attendance.findMany({
      where: { gym_id: gymId, checked_in_at: { gte: last30Days } },
      select: { checked_in_at: true },
    });

    const hourCounts = Array(24).fill(0);
    for (const { checked_in_at } of recentCheckins) {
      hourCounts[new Date(checked_in_at).getHours()]++;
    }
    const peak_hours = hourCounts
      .map((count, hour) => ({ hour, count }))
      .filter((h) => h.count > 0);

    // Top 10 members by visit count this month
    const topMembersRaw = await prisma.attendance.groupBy({
      by: ['member_id'],
      where: { gym_id: gymId, checked_in_at: { gte: startOfMonth } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    });

    const memberIds = topMembersRaw.map((r) => r.member_id);
    const memberNames = memberIds.length > 0
      ? await prisma.member.findMany({
          where: { id: { in: memberIds } },
          select: { id: true, name: true },
        })
      : [];

    const nameMap = new Map(memberNames.map((m) => [m.id, m.name]));
    const top_members = topMembersRaw.map((r) => ({
      member_id: r.member_id,
      name: nameMap.get(r.member_id) || 'Unknown',
      visit_count: r._count.id,
    }));

    return sendSuccess(res, {
      today_count: todayCount,
      week_count: weekCount,
      month_count: monthCount,
      peak_hours,
      top_members,
    }, 'Attendance stats retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /owner/members/:memberId/attendance-stats
 * Returns total visit count and last visit date for a specific member.
 * Used by the member profile page.
 */
async function getMemberAttendanceStats(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const memberId = parseInt(req.params.memberId, 10);
  if (!memberId) return sendError(res, 'Invalid memberId.', 400);

  try {
    const [total_visits, lastRecord] = await Promise.all([
      prisma.attendance.count({ where: { gym_id: gymId, member_id: memberId } }),
      prisma.attendance.findFirst({
        where: { gym_id: gymId, member_id: memberId },
        orderBy: { checked_in_at: 'desc' },
        select: { checked_in_at: true },
      }),
    ]);

    return sendSuccess(res, {
      total_visits,
      last_visit: lastRecord?.checked_in_at ?? null,
    }, 'Member attendance stats retrieved.');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  checkIn,
  checkOut,
  listAttendance,
  getAttendanceStats,
  getMemberAttendanceStats,
};
