'use strict';

const prisma = require('../lib/prisma');

// Statuses that indicate an active renewal cycle for a member.
// Used to prevent duplicate renewals within the same cycle.
// 'processing_link' is a transient lock status held while Razorpay link
// creation is in-flight; it must be included so createRenewalIfNotExists
// does not create a second renewal for the same member during that window.
const ACTIVE_STATUSES = ['pending', 'processing_link', 'link_generated'];

/**
 * Creates a Renewal record for the given member unless one already exists
 * in an active status (pending or link_generated).
 *
 * @param {number} gymId
 * @param {{ id: number, plan_amount: number }} member
 * @returns {{ created: boolean, renewal: object }}
 */
async function createRenewalIfNotExists(gymId, member) {
  const existing = await prisma.renewal.findFirst({
    where: {
      member_id: member.id,
      status: { in: ACTIVE_STATUSES },
    },
  });

  if (existing) {
    return { created: false, renewal: existing };
  }

  const renewal = await prisma.renewal.create({
    data: {
      gym_id: gymId,
      member_id: member.id,
      amount: member.plan_amount,
      status: 'pending',
    },
  });

  return { created: true, renewal };
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
 * Releases the payment-link lock by resetting status back to "pending".
 * Called when Razorpay link creation fails after the lock was acquired,
 * so the renewal is eligible for retry on the next run.
 *
 * @param {number} renewalId
 * @returns {Promise<void>}
 */
async function releasePaymentLinkLock(renewalId) {
  await prisma.renewal.update({
    where: { id: renewalId },
    data: { status: 'pending' },
  });
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
 * Releases the WhatsApp send lock by resetting whatsapp_sent_at to null
 * and recording "failed" status. Called when the Meta API throws after the
 * lock was acquired, so the renewal remains eligible for retry.
 *
 * @param {number} renewalId
 * @returns {Promise<void>}
 */
async function releaseWhatsappLock(renewalId) {
  await prisma.renewal.update({
    where: { id: renewalId },
    data: {
      whatsapp_sent_at: null,
      whatsapp_status: 'failed',
    },
  });
}

/**
 * Atomically settles a paid renewal:
 * - Sets renewal.status = "paid"
 * - Extends member.expiry_date by 30 days
 * - Ensures member.status = "active"
 * Runs in a transaction so both updates succeed or neither does.
 *
 * @param {number} renewalId
 * @param {number} memberId
 * @param {Date} currentExpiry
 * @returns {Promise<void>}
 */
async function settleRenewal(renewalId, memberId, currentExpiry) {
  const newExpiry = new Date(currentExpiry);
  newExpiry.setUTCDate(newExpiry.getUTCDate() + 30);

  await prisma.$transaction([
    prisma.renewal.update({
      where: { id: renewalId },
      data: { status: 'paid' },
    }),
    prisma.member.update({
      where: { id: memberId },
      data: {
        expiry_date: newExpiry,
        status: 'active',
      },
    }),
  ]);
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
};
