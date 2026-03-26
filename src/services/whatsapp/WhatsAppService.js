'use strict';

const axios = require('axios');
const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');
const TokenManager = require('./TokenManager');
const TemplateManager = require('./TemplateManager');
const QueueProcessor = require('./QueueProcessor');
const WebhookHandler = require('./WebhookHandler');
const FallbackGenerator = require('./FallbackGenerator');

const GRAPH_API_VERSION = 'v22.0';

/**
 * Enqueues a WhatsApp message for a gym member.
 * Skips silently if gym is in fallback mode (fallback digest handles delivery).
 *
 * @param {number} gymId
 * @param {number|null} memberId
 * @param {string} templateType
 * @param {string[]} params
 * @param {string} recipientPhone
 * @param {{ trigger_type?: string, trigger_ref?: string, scheduledAt?: Date }} options
 * @returns {Promise<{ queued: boolean, id?: string, skipped?: boolean }>}
 */
async function send(gymId, memberId, templateType, params, recipientPhone, options = {}) {
  const account = await prisma.whatsappAccount.findUnique({
    where: { gym_id: gymId },
    select: { fallback_mode: true, status: true },
  });

  // Fallback mode or not onboarded → skip queue (FallbackGenerator handles digest)
  if (!account || account.fallback_mode || account.status !== 'active') {
    logger.debug('[WhatsAppService] gym in fallback mode — skipping queue', {
      gym_id: gymId,
      template_type: templateType,
    });
    return { queued: false, skipped: true };
  }

  // Fetch quiet hours from config
  const config = await prisma.whatsappConfig.findUnique({
    where: { gym_id: gymId },
    select: { quiet_start: true, quiet_end: true },
  });

  const quiet_start = config?.quiet_start ?? '21:00';
  const quiet_end = config?.quiet_end ?? '08:00';

  return QueueProcessor.enqueue(gymId, memberId, templateType, params, recipientPhone, {
    ...options,
    quiet_start,
    quiet_end,
  });
}

/**
 * Sends a time-sensitive WhatsApp message immediately, bypassing the queue.
 * Used ONLY for payment confirmations and invoices (post-webhook, can't defer).
 * Falls back to logger.warn if token or send fails — never throws.
 *
 * @param {number} gymId
 * @param {string} templateType
 * @param {string[]} params
 * @param {string} recipientPhone
 * @returns {Promise<{ messageId: string|null }>}
 */
async function sendImmediate(gymId, templateType, params, recipientPhone) {
  try {
    const { access_token } = await TokenManager.getActiveToken();

    const account = await prisma.whatsappAccount.findUnique({
      where: { gym_id: gymId },
      select: { phone_number_id: true, status: true },
    });

    if (!account?.phone_number_id) {
      logger.warn('[WhatsAppService] sendImmediate: no phone_number_id for gym', {
        gym_id: gymId,
        template_type: templateType,
      });
      return { messageId: null };
    }

    const payload = await TemplateManager.buildMessagePayload(templateType, params, recipientPhone);

    const response = await axios.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${account.phone_number_id}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' } }
    );

    const messageId = response.data?.messages?.[0]?.id ?? null;

    logger.info('[WhatsAppService] sendImmediate success', {
      gym_id: gymId,
      template_type: templateType,
      wamid: messageId,
    });

    return { messageId };
  } catch (err) {
    logger.warn('[WhatsAppService] sendImmediate failed — swallowing (payment already processed)', {
      gym_id: gymId,
      template_type: templateType,
      error: err.message,
    });
    return { messageId: null };
  }
}

/**
 * Verifies and processes a Meta webhook event.
 * @param {Buffer|string} rawBody
 * @param {string} signature  X-Hub-Signature-256 header
 * @param {object} payload    parsed JSON body
 */
async function handleWebhook(rawBody, signature, payload) {
  if (!WebhookHandler.verifySignature(rawBody, signature)) {
    logger.warn('[WhatsAppService] webhook signature verification failed');
    throw new Error('INVALID_SIGNATURE');
  }
  await WebhookHandler.handleEvent(payload);
}

/**
 * Returns the fallback digest for a gym in fallback mode.
 * @param {number} gymId
 */
async function getGymFallbackMessages(gymId) {
  return FallbackGenerator.generateDailyDigest(gymId);
}

module.exports = { send, sendImmediate, handleWebhook, getGymFallbackMessages };
