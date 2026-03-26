'use strict';

const logger = require('../config/logger');
const { handleWebhook } = require('../services/whatsapp/WhatsAppService');

/**
 * GET /api/internal/whatsapp/webhook
 * Meta's one-time webhook verification challenge.
 * Responds with hub.challenge if hub.verify_token matches META_WEBHOOK_VERIFY_TOKEN.
 */
async function verifyWebhookChallenge(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    logger.info('[whatsappWebhook] challenge verified');
    return res.status(200).send(challenge);
  }

  logger.warn('[whatsappWebhook] challenge failed — token mismatch or wrong mode', { mode });
  return res.status(403).json({ success: false, message: 'Forbidden' });
}

/**
 * POST /api/internal/whatsapp/webhook
 * Receives Meta delivery status updates and incoming messages.
 * Always returns 200 — Meta retries on any non-200 response.
 */
async function handleWhatsAppWebhook(req, res) {
  // Always ack immediately so Meta doesn't retry
  res.status(200).send('EVENT_RECEIVED');

  try {
    const rawBody  = req.body; // Buffer — set by express.raw() in whatsapp.routes.js
    const signature = req.headers['x-hub-signature-256'] ?? '';
    const payload  = JSON.parse(rawBody.toString('utf8'));

    await handleWebhook(rawBody, signature, payload);
  } catch (err) {
    // Log but never let an error surface to Meta (response already sent)
    logger.error('[whatsappWebhook] error processing event', {
      error: err.message,
      stack: err.stack,
    });
  }
}

module.exports = { verifyWebhookChallenge, handleWhatsAppWebhook };
