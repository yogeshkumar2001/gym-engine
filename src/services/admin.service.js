'use strict';

const prisma = require('../lib/prisma');
const { getTargetDayWindow } = require('../utils/dateUtils');
const { MAX_RETRY } = require('../utils/retryPolicy');
const { getLastHealthCronRunAt } = require('../cron/credentialHealthCron');

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
    gymsWithInvalidCredentials,
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

    // 8. Gyms where at least one credential was explicitly marked invalid
    //    by the credential health cron (false = checked & failed; null = never checked).
    prisma.gym.count({
      where: {
        OR: [
          { razorpay_valid: false },
          { whatsapp_valid: false },
          { sheet_valid:    false },
        ],
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
    gymsWithInvalidCredentials,

    // Timestamp of the most recent credential health check run.
    // null until the process has completed at least one run since startup.
    lastHealthCheckRunAt: getLastHealthCronRunAt(),
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
    maxRetryReached,
  ] = await Promise.all([
    // 1. Gym lifecycle info — no credentials returned
    prisma.gym.findUnique({
      where: { id: gymId },
      select: {
        id:                   true,
        name:                 true,
        status:               true,
        last_health_check_at: true,
        last_error_message:   true,
        razorpay_valid:       true,
        whatsapp_valid:       true,
        sheet_valid:          true,
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

    // 8. Retry avg — aggregate across all renewals for this gym
    prisma.renewal.aggregate({
      _avg: { retry_count: true },
      where: { gym_id: gymId },
    }),

    // 9. Count renewals that have hit or exceeded MAX_RETRY
    prisma.renewal.count({
      where: { gym_id: gymId, retry_count: { gte: MAX_RETRY } },
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

  // Extract per-credential flags before building the gym summary object so
  // credentials aren't duplicated at the top level.
  const { razorpay_valid, whatsapp_valid, sheet_valid, ...gymSummary } = gym;

  return {
    gym: gymSummary,
    renewalBreakdown,
    todayStats: {
      remindersSent,
      renewalsPaid,
      revenueRecovered: revenueResult._sum.amount ?? 0,
    },
    stuckRenewalsCount,
    failedWhatsAppCount,
    retryStats: {
      maxRetryReached,
      deadRenewals: renewalBreakdown.dead,
      avgRetryCount: parseFloat((retryAgg._avg.retry_count ?? 0).toFixed(2)),
    },
    // Per-integration credential validity from the last health check cron run.
    // null = never checked (gym was activated but health cron hasn't run yet).
    credentialStatus: {
      razorpayValid: razorpay_valid ?? null,
      whatsappValid: whatsapp_valid ?? null,
      sheetValid:    sheet_valid    ?? null,
    },
  };
}

// ─── Subscription Management ──────────────────────────────────────────────────

/**
 * Sets or clears the subscription expiry date for a gym.
 *
 * @param {number} gymId
 * @param {Date|null} expiresAt  — null means unlimited (no enforcement)
 * @returns {Promise<void>}
 * @throws {{ status: 404 }} if the gym does not exist
 */
async function updateGymSubscription(gymId, expiresAt) {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { id: true },
  });

  if (!gym) {
    const err = new Error('Gym not found.');
    err.status = 404;
    throw err;
  }

  await prisma.gym.update({
    where: { id: gymId },
    data: { subscription_expires_at: expiresAt },
  });
}

// ─── Recovery Stats ───────────────────────────────────────────────────────────

/**
 * Returns recovery engine metrics for a gym.
 *
 * expired_unpaid_members — active members past expiry with no paid renewal
 * in_recovery_count      — link_generated renewals currently in recovery (step 1-2)
 * recovery_step_breakdown — count per step { step_1, step_2 }
 * recovered_count        — paid renewals that came through recovery (recovery_step > 0)
 * recovered_revenue      — sum of their amounts
 * discount_applied_count — renewals where a discount link was created (step 2+)
 * recovery_rate          — recovered / (recovered + expired_unpaid)
 *
 * Queries run sequentially to respect the pool limit of 5.
 *
 * @param {number} gymId
 * @returns {Promise<object>}
 */
async function getRecoveryStats(gymId) {
  const now = new Date();

  const expiredUnpaidCount = await prisma.member.count({
    where: {
      gym_id: gymId,
      status: 'active',
      expiry_date: { lt: now },
      renewals: { none: { status: 'paid' } },
    },
  });

  const recoveryBreakdown = await prisma.renewal.groupBy({
    by: ['recovery_step'],
    where: {
      gym_id: gymId,
      status: 'link_generated',
      recovery_step: { gt: 0 },
    },
    _count: { id: true },
  });

  const recoveredResult = await prisma.renewal.aggregate({
    where: {
      gym_id: gymId,
      status: 'paid',
      recovery_step: { gt: 0 },
    },
    _count: { id: true },
    _sum: { amount: true },
  });

  const discountAppliedCount = await prisma.renewal.count({
    where: {
      gym_id: gymId,
      discount_percent: { not: null },
    },
  });

  const stepBreakdown = { step_1: 0, step_2: 0 };
  for (const row of recoveryBreakdown) {
    if (row.recovery_step === 1) stepBreakdown.step_1 = row._count.id;
    if (row.recovery_step === 2) stepBreakdown.step_2 = row._count.id;
  }

  const inRecoveryCount = stepBreakdown.step_1 + stepBreakdown.step_2;
  const recoveredCount = recoveredResult._count.id;
  const recoveredRevenue = recoveredResult._sum.amount || 0;
  const total = recoveredCount + expiredUnpaidCount;
  const recoveryRate = total > 0 ? Math.round((recoveredCount / total) * 1000) / 1000 : 0;

  return {
    expired_unpaid_members: expiredUnpaidCount,
    in_recovery_count: inRecoveryCount,
    recovery_step_breakdown: stepBreakdown,
    recovered_count: recoveredCount,
    recovered_revenue: Math.round(recoveredRevenue * 100) / 100,
    discount_applied_count: discountAppliedCount,
    recovery_rate: recoveryRate,
  };
}

/**
 * Lists all gyms with lightweight summary fields.
 * Used by the admin portal gym list page.
 *
 * @returns {Promise<Array>}
 */
async function listGyms() {
  return prisma.gym.findMany({
    select: {
      id:                     true,
      name:                   true,
      status:                 true,
      owner_phone:            true,
      subscription_expires_at: true,
      last_health_check_at:   true,
      last_error_message:     true,
      razorpay_valid:         true,
      whatsapp_valid:         true,
      sheet_valid:            true,
      created_at:             true,
    },
    orderBy: { id: 'asc' },
  });
}

module.exports = { detectStuckRenewals, getGlobalHealth, getGymDeepHealth, updateGymSubscription, getRecoveryStats, listGyms };
