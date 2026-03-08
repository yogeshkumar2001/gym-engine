'use strict';

const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { MAX_RETRY, getBackoffMinutes } = require('../utils/retryPolicy');

// Statuses that indicate an in-progress renewal cycle for the purposes of
// deduplication in createRenewalIfNotExists.  'dead' is intentionally excluded:
// a dead renewal from a previous expiry cycle must not permanently block a new
// renewal when the member's next expiry window arrives.
const IN_PROGRESS_STATUSES = ['pending', 'processing_link', 'link_generated'];

// Broader set used by getPendingRenewalsByGym (admin / health views).
const ACTIVE_STATUSES = ['pending', 'processing_link', 'link_generated', 'dead'];

/**
 * Creates a Renewal record for the given member unless one already exists
 * in an active status (pending or link_generated).
 *
 * Snapshots plan_duration_days from the member record at creation time so that
 * subsequent plan changes do not affect outstanding renewals.
 *
 * @param {number} gymId
 * @param {{ id: number, plan_amount: number, plan_duration_days: number }} member
 * @returns {{ created: boolean, renewal: object }}
 */
async function createRenewalIfNotExists(gymId, member) {
  try {
    return await prisma.$transaction(async (tx) => {
      // Serializable isolation prevents phantom reads: exactly one concurrent
      // caller will see no existing row and succeed in creating the renewal.
      // The other will either see the newly-created row or receive P2034.
      const existing = await tx.renewal.findFirst({
        where: { member_id: member.id, status: { in: IN_PROGRESS_STATUSES } },
      });

      if (existing) return { created: false, renewal: existing };

      const renewal = await tx.renewal.create({
        data: {
          gym_id:             gymId,
          member_id:          member.id,
          amount:             member.plan_amount,
          plan_duration_days: member.plan_duration_days ?? 30,
          status:             'pending',
        },
      });

      return { created: true, renewal };
    }, { isolationLevel: 'Serializable' });
  } catch (err) {
    // P2034 = serialization failure — a concurrent transaction already created
    // the renewal.  Retry once outside the transaction to return the existing row.
    if (err.code === 'P2034') {
      logger.debug('[createRenewalIfNotExists] Serialization conflict — fetching existing renewal', {
        member_id: member.id,
      });
      const existing = await prisma.renewal.findFirst({
        where: { member_id: member.id, status: { in: IN_PROGRESS_STATUSES } },
      });
      if (existing) return { created: false, renewal: existing };
    }
    throw err;
  }
}

/**
 * Returns all renewals in active statuses for a given gym,
 * with basic member info included.
 *
 * @param {number} gymId
 * @returns {Promise<object[]>}
 */
async function getPendingRenewalsByGym(gymId) {
  return prisma.renewal.findMany({
    where: {
      gym_id: gymId,
      status: { in: ACTIVE_STATUSES },
    },
    include: {
      member: {
        select: {
          id: true,
          name: true,
          phone: true,
          plan_name: true,
          expiry_date: true,
        },
      },
    },
    orderBy: { created_at: 'desc' },
    take: 500,
  });
}

/**
 * Updates the status of a Renewal record.
 * Valid transitions: pending → link_generated → paid | failed | cancelled
 *
 * @param {number} renewalId
 * @param {string} status
 * @returns {Promise<object>}
 */
async function updateRenewalStatus(renewalId, status) {
  return prisma.renewal.update({
    where: { id: renewalId },
    data: { status },
  });
}

/**
 * Marks a Renewal as link_generated and stores the Razorpay payment link details.
 *
 * @param {number} renewalId
 * @param {string} paymentLinkId
 * @param {string} shortUrl
 * @returns {Promise<object>}
 */
async function markLinkGenerated(renewalId, paymentLinkId, shortUrl) {
  return prisma.renewal.update({
    where: { id: renewalId },
    data: {
      status: 'link_generated',
      razorpay_payment_link_id: paymentLinkId,
      razorpay_short_url: shortUrl,
    },
  });
}

/**
 * Atomically acquires the Razorpay link-generation lock by transitioning
 * the renewal from "pending" to "processing_link" in a single UPDATE.
 *
 * MySQL serializes concurrent UPDATEs at the row level, so exactly one caller
 * receives count=1. All others receive count=0 and must not generate a link.
 *
 * @param {number} renewalId
 * @returns {Promise<boolean>} — true if this caller now owns the lock
 */
async function acquirePaymentLinkLock(renewalId) {
  const result = await prisma.renewal.updateMany({
    where: { id: renewalId, status: 'pending' },
    data: { status: 'processing_link' },
  });
  return result.count === 1;
}

/**
 * Releases the payment-link lock after a Razorpay failure.
 *
 * Atomically (inside a transaction):
 *   1. Resets status to "pending", increments retry_count, stamps last_retry_at.
 *   2. If retry_count has now reached MAX_RETRY, upgrades status to "dead" — the
 *      renewal will never be processed again by the cron.
 *
 * The two-step design is intentional: the first UPDATE always lands the retry
 * increment; the conditional second UPDATE only fires when the threshold is hit.
 * Both updates are within the same transaction so they either both commit or
 * neither does — no partial state escapes.
 *
 * @param {number} renewalId
 * @returns {Promise<void>}
 */
async function releasePaymentLinkLock(renewalId) {
  const updated = await prisma.$transaction(async (tx) => {
    const incremented = await tx.renewal.update({
      where: { id: renewalId },
      data: {
        status: 'pending',
        retry_count: { increment: 1 },
        last_retry_at: new Date(),
      },
    });

    if (incremented.retry_count >= MAX_RETRY) {
      return tx.renewal.update({
        where: { id: renewalId },
        data: { status: 'dead' },
      });
    }

    return incremented;
  });

  if (updated.status === 'dead') {
    logger.warn('[renewalService] Renewal dead — max retries reached (payment link)', {
      renewal_id: renewalId,
      retry_count: updated.retry_count,
    });
  } else {
    logger.info('[renewalService] Payment link lock released — retry scheduled', {
      renewal_id: renewalId,
      retry_count: updated.retry_count,
      backoff_minutes: getBackoffMinutes(updated.retry_count),
    });
  }
}

/**
 * Atomically acquires the WhatsApp send lock by setting whatsapp_sent_at
 * and flipping whatsapp_status to "sending" in a single UPDATE.
 *
 * The WHERE clause `whatsapp_sent_at: null` ensures only one concurrent
 * caller can win. All others receive count=0 and must not call the API.
 *
 * @param {number} renewalId
 * @param {Date} sentAt  — timestamp to stamp; usually the cron's `now`
 * @returns {Promise<boolean>} — true if this caller now owns the send slot
 */
async function acquireWhatsappLock(renewalId, sentAt) {
  const result = await prisma.renewal.updateMany({
    where: {
      id: renewalId,
      status: 'link_generated',
      whatsapp_sent_at: null,
    },
    data: {
      whatsapp_sent_at: sentAt,
      whatsapp_status: 'sending',
    },
  });
  return result.count === 1;
}

/**
 * Releases the WhatsApp send lock after a Meta API failure.
 *
 * Atomically (inside a transaction):
 *   1. Resets whatsapp_sent_at to null, marks whatsapp_status "failed",
 *      increments retry_count, stamps last_retry_at.
 *      The renewal's main status stays "link_generated" — the payment link
 *      is still valid; only the send attempt failed.
 *   2. If retry_count has now reached MAX_RETRY, upgrades status to "dead".
 *
 * @param {number} renewalId
 * @returns {Promise<void>}
 */
async function releaseWhatsappLock(renewalId) {
  const updated = await prisma.$transaction(async (tx) => {
    const incremented = await tx.renewal.update({
      where: { id: renewalId },
      data: {
        whatsapp_sent_at: null,
        whatsapp_status: 'failed',
        retry_count: { increment: 1 },
        last_retry_at: new Date(),
      },
    });

    if (incremented.retry_count >= MAX_RETRY) {
      return tx.renewal.update({
        where: { id: renewalId },
        data: { status: 'dead' },
      });
    }

    return incremented;
  });

  if (updated.status === 'dead') {
    logger.warn('[renewalService] Renewal dead — max retries reached (WhatsApp)', {
      renewal_id: renewalId,
      retry_count: updated.retry_count,
    });
  } else {
    logger.info('[renewalService] WhatsApp lock released — retry scheduled', {
      renewal_id: renewalId,
      retry_count: updated.retry_count,
      backoff_minutes: getBackoffMinutes(updated.retry_count),
    });
  }
}

/**
 * Atomically settles a paid renewal:
 * - Sets renewal.status = "paid"
 * - Extends member.expiry_date by planDurationDays (snapshotted on the renewal)
 * - Ensures member.status = "active"
 * Runs in a transaction so both updates succeed or neither does.
 *
 * @param {number} renewalId
 * @param {number} memberId
 * @param {Date}   currentExpiry
 * @param {number} planDurationDays  — from renewal.plan_duration_days (e.g. 30, 90, 365)
 * @returns {Promise<void>}
 */
async function settleRenewal(renewalId, memberId, currentExpiry, planDurationDays) {
  const days = (Number.isInteger(planDurationDays) && planDurationDays > 0)
    ? planDurationDays
    : 30; // safe fallback — should never be reached with schema default

  const newExpiry = new Date(currentExpiry);
  newExpiry.setUTCDate(newExpiry.getUTCDate() + days);

  await prisma.$transaction(async (tx) => {
    // Atomic claim: only the first concurrent caller gets count=1.
    // If count=0 the renewal was already settled — return without
    // touching the member record (idempotent, no double-extension).
    const claim = await tx.renewal.updateMany({
      where: { id: renewalId, status: { not: 'paid' } },
      data: { status: 'paid' },
    });

    if (claim.count === 0) {
      logger.info('[settleRenewal] Renewal already settled — skipping member update', { renewal_id: renewalId });
      return;
    }

    await tx.member.update({
      where: { id: memberId },
      data: {
        expiry_date: newExpiry,
        status: 'active',
      },
    });
  });
}

// ─── Recovery Engine ──────────────────────────────────────────────────────────

/**
 * Atomically advances the recovery_step from `fromStep` to `toStep`.
 * Uses MySQL row-level locking (same pattern as acquirePaymentLinkLock):
 * exactly one concurrent caller receives count=1; all others receive count=0.
 *
 * @param {number} renewalId
 * @param {number} fromStep  — expected current step (guard condition)
 * @param {number} toStep    — next step to transition to
 * @returns {Promise<boolean>} true if this caller owns the transition
 */
async function advanceRecoveryStep(renewalId, fromStep, toStep) {
  const result = await prisma.renewal.updateMany({
    where: { id: renewalId, recovery_step: fromStep },
    data: { recovery_step: toStep },
  });
  return result.count === 1;
}

/**
 * Updates a renewal with a discounted Razorpay payment link.
 * Replaces the original link so webhook settlement works for the new link.
 * Also updates `amount` to the discounted value for correct revenue tracking.
 *
 * @param {number} renewalId
 * @param {string} paymentLinkId   — new Razorpay link ID
 * @param {string} shortUrl        — new short URL for WhatsApp
 * @param {number} discountPercent — e.g. 5 for 5%
 * @param {number} discountedAmount
 */
async function applyDiscountToRenewal(renewalId, paymentLinkId, shortUrl, discountPercent, discountedAmount) {
  // Guard: only apply discount if none has been applied yet (discount_percent IS NULL).
  // Prevents double-discounting if this function is somehow called twice for the same renewal.
  const result = await prisma.renewal.updateMany({
    where: { id: renewalId, discount_percent: null },
    data: {
      razorpay_payment_link_id: paymentLinkId,
      razorpay_short_url: shortUrl,
      discount_percent: discountPercent,
      discounted_amount: discountedAmount,
      amount: discountedAmount,
    },
  });
  if (result.count === 0) {
    logger.warn('[applyDiscountToRenewal] Discount already applied — skipping', { renewal_id: renewalId });
  }
}

/**
 * Marks a renewal's recovery sequence as completed.
 * Called after the final notice (step 3) is sent.
 *
 * @param {number} renewalId
 */
async function markRecoveryCompleted(renewalId) {
  await prisma.renewal.update({
    where: { id: renewalId },
    data: { recovery_completed: true },
  });
}

module.exports = {
  createRenewalIfNotExists,
  getPendingRenewalsByGym,
  updateRenewalStatus,
  markLinkGenerated,
  acquirePaymentLinkLock,
  releasePaymentLinkLock,
  acquireWhatsappLock,
  releaseWhatsappLock,
  settleRenewal,
  advanceRecoveryStep,
  applyDiscountToRenewal,
  markRecoveryCompleted,
};
