'use strict';

const crypto = require('crypto');
const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');
const { enqueue } = require('./QueueProcessor');

const STATUS_MAP = {
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

/**
 * Verifies a Meta webhook signature (X-Hub-Signature-256).
 * @param {Buffer|string} rawBody
 * @param {string} signature  value of X-Hub-Signature-256 header
 * @returns {boolean}
 */
function verifySignature(rawBody, signature) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    logger.error('[WebhookHandler] META_APP_SECRET not set');
    return false;
  }

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const sigBuffer = Buffer.from(signature ?? '');
  const expBuffer = Buffer.from(expected);

  if (sigBuffer.length !== expBuffer.length) return false;
  return crypto.timingSafeEqual(sigBuffer, expBuffer);
}

/**
 * Routes a Meta webhook payload by event type.
 * @param {object} payload  parsed JSON body
 */
async function handleEvent(payload) {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      if (value.statuses) {
        await handleStatusUpdate(value);
      } else if (value.messages) {
        await handleIncomingMessage(value);
      }
    }
  }
}

/**
 * Handles delivery/read/failed status updates from Meta.
 * @param {object} value  change.value
 */
async function handleStatusUpdate(value) {
  for (const s of value.statuses ?? []) {
    const newStatus = STATUS_MAP[s.status];
    if (!newStatus) continue;

    const row = await prisma.messageQueue.findFirst({ where: { wamid: s.id } });
    if (!row) {
      logger.debug('[WebhookHandler] handleStatusUpdate: wamid not found', { wamid: s.id });
      continue;
    }

    const data = { status: newStatus };
    if (newStatus === 'delivered') data.delivered_at = new Date();
    if (newStatus === 'read')      data.read_at = new Date();
    if (newStatus === 'failed')    data.failed_at = new Date();

    await prisma.messageQueue.update({ where: { id: row.id }, data });

    logger.debug('[WebhookHandler] status updated', { wamid: s.id, status: newStatus });
  }
}

/**
 * Handles incoming messages from members.
 * - 'PAID'  → settle the open renewal
 * - 'STOP'  → log opt-out (member.whatsapp_opt_out added in Phase 3)
 * - else    → forward text to gym owner
 *
 * @param {object} value  change.value
 */
async function handleIncomingMessage(value) {
  const phoneNumberId = value.metadata?.phone_number_id;

  const account = await prisma.whatsappAccount.findFirst({
    where: { phone_number_id: phoneNumberId },
    select: { gym_id: true },
  });

  if (!account) {
    logger.warn('[WebhookHandler] incoming message: unknown phone_number_id', { phone_number_id: phoneNumberId });
    return;
  }

  const { gym_id } = account;

  for (const message of value.messages ?? []) {
    const senderPhone = message.from;
    const body = (message.text?.body ?? '').trim().toUpperCase();

    if (body === 'PAID') {
      await handlePaidReply(gym_id, senderPhone);
    } else if (body === 'STOP') {
      logger.info('[WebhookHandler] STOP received — opt-out logged (Phase 3 will persist)', {
        gym_id,
        phone: senderPhone,
      });
    } else {
      // Forward to gym owner
      const gym = await prisma.gym.findUnique({
        where: { id: gym_id },
        select: { owner_phone: true },
      });

      if (gym?.owner_phone) {
        await enqueue(
          gym_id,
          null,
          'member_reply_forward',
          [senderPhone, message.text?.body ?? ''],
          gym.owner_phone,
          { trigger_type: 'manual' }
        );
      }
    }
  }
}

/**
 * Finds the open renewal for a member by phone and settles it as manual payment.
 * @param {number} gymId
 * @param {string} senderPhone
 */
async function handlePaidReply(gymId, senderPhone) {
  const member = await prisma.member.findFirst({
    where: { gym_id: gymId, phone: senderPhone },
    select: { id: true, expiry_date: true, plan_duration_days: true },
  });

  if (!member) {
    logger.warn('[WebhookHandler] PAID reply from unknown member', { gym_id: gymId, phone: senderPhone });
    return;
  }

  const renewal = await prisma.renewal.findFirst({
    where: {
      gym_id: gymId,
      member_id: member.id,
      status: { in: ['pending', 'link_generated'] },
    },
    orderBy: { created_at: 'desc' },
  });

  if (!renewal) {
    logger.info('[WebhookHandler] PAID reply but no open renewal found', {
      gym_id: gymId,
      member_id: member.id,
    });
    return;
  }

  // Lazy require to avoid circular dep at module load time
  const { settleRenewal } = require('../../services/renewalService');
  await settleRenewal(renewal.id, member.id, member.expiry_date, renewal.plan_duration_days, 'manual');

  logger.info('[WebhookHandler] renewal settled via PAID reply', {
    gym_id: gymId,
    renewal_id: renewal.id,
    member_id: member.id,
  });
}

module.exports = { verifySignature, handleEvent, handleStatusUpdate, handleIncomingMessage };
