'use strict';

const prisma = require('../lib/prisma');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * GET /owner/messages/stats
 * Returns delivery stats for the last 30 days, grouped by date (IST calendar day).
 * Response shape:
 *   { total_sent, total_delivered, total_failed, read_rate, daily: [...] }
 */
async function getMessageStats(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  try {
    const rows = await prisma.messageQueue.findMany({
      where: {
        gym_id: gymId,
        created_at: { gt: cutoff },
        status: { in: ['sent', 'delivered', 'read', 'failed', 'dead'] },
      },
      select: { status: true, sent_at: true, delivered_at: true, read_at: true, created_at: true },
      orderBy: { created_at: 'asc' },
    });

    // Group by IST calendar date (UTC+5:30)
    const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
    const dailyMap = new Map();

    for (const row of rows) {
      const istDate = new Date((row.created_at?.getTime() ?? 0) + IST_OFFSET_MS);
      const key = istDate.toISOString().slice(0, 10); // 'YYYY-MM-DD'

      if (!dailyMap.has(key)) {
        dailyMap.set(key, { date: key, sent: 0, delivered: 0, read: 0, failed: 0 });
      }
      const day = dailyMap.get(key);

      if (['sent', 'delivered', 'read'].includes(row.status)) day.sent++;
      if (row.status === 'delivered' || row.status === 'read') day.delivered++;
      if (row.status === 'read') day.read++;
      if (row.status === 'failed' || row.status === 'dead') day.failed++;
    }

    const daily = [...dailyMap.values()];

    const totalSent      = daily.reduce((s, d) => s + d.sent, 0);
    const totalDelivered = daily.reduce((s, d) => s + d.delivered, 0);
    const totalRead      = daily.reduce((s, d) => s + d.read, 0);
    const totalFailed    = daily.reduce((s, d) => s + d.failed, 0);
    const readRate = totalSent > 0 ? Math.round((totalRead / totalSent) * 10000) / 100 : 0;

    return sendSuccess(res, {
      total_sent: totalSent,
      total_delivered: totalDelivered,
      total_failed: totalFailed,
      read_rate: readRate,
      daily,
    }, 'Message stats retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /owner/messages/recovery/:memberId
 * Returns the full recovery message timeline for a member.
 * Only returns rows belonging to the requesting gym (scoped by gym_id + member_id).
 */
async function getMemberRecoveryTimeline(req, res, next) {
  const gymId   = req.gymOwner.gym_id;
  const memberId = parseInt(req.params.memberId, 10);

  if (!Number.isInteger(memberId) || memberId <= 0) {
    return sendError(res, 'Invalid memberId.', 400);
  }

  try {
    // Verify member belongs to this gym
    const member = await prisma.member.findFirst({
      where: { id: memberId, gym_id: gymId },
      select: { id: true, name: true, phone: true },
    });

    if (!member) {
      return sendError(res, 'Member not found.', 404);
    }

    const messages = await prisma.messageQueue.findMany({
      where: { gym_id: gymId, member_id: memberId },
      select: {
        id: true,
        template_type: true,
        status: true,
        created_at: true,
        scheduled_at: true,
        sent_at: true,
        delivered_at: true,
        read_at: true,
        failed_at: true,
        error_code: true,
        attempts: true,
        trigger_type: true,
      },
      orderBy: { created_at: 'asc' },
    });

    return sendSuccess(res, {
      member: { id: member.id, name: member.name, phone: member.phone },
      messages,
    }, 'Recovery timeline retrieved.');
  } catch (err) {
    next(err);
  }
}

module.exports = { getMessageStats, getMemberRecoveryTimeline };
