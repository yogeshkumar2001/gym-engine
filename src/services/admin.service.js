'use strict';

const prisma = require('../lib/prisma');
const { getTargetDayWindow } = require('../utils/dateUtils');

// ─── Renewal status constants ─────────────────────────────────────────────────
const RENEWAL_STATUSES = ['pending', 'processing_link', 'link_generated', 'paid', 'failed', 'dead'];

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Counts renewals stuck in "processing_link" longer than `minutesThreshold`.
 * Scoped to a single gym when `gymId` is provided; global otherwise.
 *
 * A stuck renewal is one whose atomic lock was acquired but never released —
 * indicating the Razorpay API call crashed the process mid-flight.
 *
 * @param {number} minutesThreshold
 * @param {number|null} gymId
 * @returns {Promise<number>}
 */
async function detectStuckRenewals(minutesThreshold, gymId = null) {
  const cutoff = new Date(Date.now() - minutesThreshold * 60 * 1000);
  const where = {
    status: 'processing_link',
    updated_at: { lt: cutoff },
  };
  if (gymId !== null) where.gym_id = gymId;
  return prisma.renewal.count({ where });
}

// ─── Global Health ────────────────────────────────────────────────────────────

/**
 * Aggregates platform-wide health metrics in a single round-trip using
 * Promise.all — no sequential queries, no N+1 problems.
 *
 * @returns {Promise<object>}
 */
async function getGlobalHealth() {
  const { startOfTargetDay: startOfToday, endOfTargetDay: endOfToday } = getTargetDayWindow(0);
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    gymGroups,
    renewalGroups,
    totalFailedWhatsApp,
    totalPaidToday,
    revenueResult,
    stuckRenewalsCount,
    gymsWithErrorsLast24h,
  ] = await Promise.all([
    // 1. Gym counts by lifecycle status
    prisma.gym.groupBy({
      by: ['status'],
      _count: { id: true },
    }),

    // 2. Renewal counts by status (pending, processing_link, link_generated, paid, failed, dead)
    prisma.renewal.groupBy({
      by: ['status'],
      _count: { id: true },
    }),

    // 3. Renewals where the WhatsApp send failed (separate field, not renewal status)
    prisma.renewal.count({
      where: { whatsapp_status: 'failed' },
    }),

    // 4. Paid renewals today
    prisma.renewal.count({
      where: {
        status: 'paid',
        updated_at: { gte: startOfToday, lte: endOfToday },
      },
    }),

    // 5. Revenue collected today
    prisma.renewal.aggregate({
      _sum: { amount: true },
      where: {
        status: 'paid',
        updated_at: { gte: startOfToday, lte: endOfToday },
      },
    }),

    // 6. Stuck renewals (processing_link > 10 minutes)
    detectStuckRenewals(10),

    // 7. Gyms that errored in the last 24 hours
    prisma.gym.count({
      where: {
        last_error_message: { not: null },
        last_error_at: { gte: twentyFourHoursAgo },
      },
    }),
  ]);

  // Build lookup maps from groupBy results
  const gymCounts = {};
  for (const g of gymGroups) gymCounts[g.status] = g._count.id;

  const renewalCounts = {};
  for (const r of renewalGroups) renewalCounts[r.status] = r._count.id;

  const totalGyms = Object.values(gymCounts).reduce((sum, n) => sum + n, 0);

  return {
    totalGyms,
    activeGyms:      gymCounts['active']      ?? 0,
    onboardingGyms:  gymCounts['onboarding']  ?? 0,
    errorGyms:       gymCounts['error']        ?? 0,
    suspendedGyms:   gymCounts['suspended']    ?? 0,

    totalPendingRenewals: renewalCounts['pending']          ?? 0,
    totalProcessingLink:  renewalCounts['processing_link']  ?? 0,
    totalLinkGenerated:   renewalCounts['link_generated']   ?? 0,
    totalFailedWhatsApp,
    totalDeadRenewals:    renewalCounts['dead']             ?? 0,

    totalPaidToday,
    totalRevenueToday: revenueResult._sum.amount ?? 0,

    stuckRenewalsCount,
    gymsWithErrorsLast24h,
  };
}

// ─── Per-Gym Deep Health ──────────────────────────────────────────────────────

/**
 * Returns a detailed health snapshot for one gym.
 * All queries run in parallel — O(1) round-trips regardless of data size.
 *
 * @param {number} gymId
 * @returns {Promise<object>}
 * @throws {{ status: 404 }} if gym does not exist
 */
async function getGymDeepHealth(gymId) {
  const { startOfTargetDay: startOfToday, endOfTargetDay: endOfToday } = getTargetDayWindow(0);
  const todayFilter = { gte: startOfToday, lte: endOfToday };

  const [
    gym,
    renewalGroups,
    remindersSent,
    renewalsPaid,
    revenueResult,
    stuckRenewalsCount,
    failedWhatsAppCount,
    retryAgg,
  ] = await Promise.all([
    // 1. Gym lifecycle info — no credentials returned
    prisma.gym.findUnique({
      where: { id: gymId },
      select: {
        id: true,
        name: true,
        status: true,
        last_health_check_at: true,
        last_error_message: true,
      },
    }),

    // 2. Renewal breakdown by status
    prisma.renewal.groupBy({
      by: ['status'],
      where: { gym_id: gymId },
      _count: { id: true },
    }),

    // 3. Today: WhatsApp reminders sent
    prisma.renewal.count({
      where: {
        gym_id: gymId,
        whatsapp_sent_at: todayFilter,
      },
    }),

    // 4. Today: renewals paid
    prisma.renewal.count({
      where: {
        gym_id: gymId,
        status: 'paid',
        updated_at: todayFilter,
      },
    }),

    // 5. Today: revenue recovered
    prisma.renewal.aggregate({
      _sum: { amount: true },
      where: {
        gym_id: gymId,
        status: 'paid',
        updated_at: todayFilter,
      },
    }),

    // 6. Stuck renewals for this gym
    detectStuckRenewals(10, gymId),

    // 7. Failed WhatsApp sends for this gym
    prisma.renewal.count({
      where: { gym_id: gymId, whatsapp_status: 'failed' },
    }),

    // 8. Retry statistics
    prisma.renewal.aggregate({
      _max: { retry_count: true },
      _avg: { retry_count: true },
      where: { gym_id: gymId },
    }),
  ]);

  if (!gym) {
    const err = new Error('Gym not found.');
    err.status = 404;
    throw err;
  }

  // Build renewal breakdown with explicit zero defaults for all known statuses
  const renewalCounts = {};
  for (const r of renewalGroups) renewalCounts[r.status] = r._count.id;

  const renewalBreakdown = {};
  for (const status of RENEWAL_STATUSES) {
    renewalBreakdown[status] = renewalCounts[status] ?? 0;
  }

  return {
    gym,
    renewalBreakdown,
    todayStats: {
      remindersSent,
      renewalsPaid,
      revenueRecovered: revenueResult._sum.amount ?? 0,
    },
    stuckRenewalsCount,
    failedWhatsAppCount,
    retryStats: {
      maxRetryCount:  retryAgg._max.retry_count ?? 0,
      avgRetryCount:  parseFloat((retryAgg._avg.retry_count ?? 0).toFixed(2)),
    },
  };
}

module.exports = { detectStuckRenewals, getGlobalHealth, getGymDeepHealth };
