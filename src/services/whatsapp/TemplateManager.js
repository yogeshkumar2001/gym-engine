'use strict';

const axios = require('axios');
const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');

const GRAPH_API_VERSION = 'v22.0';

// Fallback plain-text templates for fallback_mode gyms
const FALLBACK_TEXTS = {
  renewal_reminder:     (p) => `Hi ${p[0]}, your gym membership is expiring soon. Please renew: ${p[1]}`,
  renewal_reminder_upi: (p) => `Hi ${p[0]}, your gym membership is expiring. Amount: ${p[1]}. Pay via UPI: ${p[2]}`,
  recovery_day1:        (p) => `Hi ${p[0]}, your gym membership has expired. Please renew to continue: ${p[1]}`,
  recovery_day2:        (p) => `Hi ${p[0]}, your gym membership expired 2 days ago. Renew now: ${p[1]}`,
  recovery_discount:    (p) => `Hi ${p[0]}, get ${p[1]}% off on your renewal! Offer expires soon: ${p[2]}`,
  recovery_final:       (p) => `Hi ${p[0]}, last chance to renew your membership: ${p[1]}`,
  daily_summary:        (p) => `Gym Summary: ${p[0]} reminders sent, ${p[1]} renewals paid, ₹${p[2]} collected, ${p[3]} pending.`,
  payment_confirm:      (p) => `Hi ${p[0]}, payment of ${p[1]} received. Your ${p[2]} plan is renewed till ${p[3]}.`,
  winback:              (p) => `Hi ${p[0]}, we miss you! Come back to ${p[2]} with ${p[1]}% off your membership.`,
  trial_welcome:        (p) => `Hi ${p[0]}, welcome to ${p[1]}! Your trial starts today.`,
  trial_followup:       (p) => `Hi ${p[0]}, how's your trial at ${p[1]} going? Ready to join full-time?`,
};

/**
 * Fetches an approved template by type and language.
 * @throws {Error} 'TEMPLATE_NOT_FOUND:{type}' if not found
 */
async function getTemplate(templateType, language = 'en') {
  const template = await prisma.whatsappTemplate.findFirst({
    where: { template_type: templateType, language, status: 'approved' },
  });

  if (!template) {
    throw new Error(`TEMPLATE_NOT_FOUND:${templateType}`);
  }

  return template;
}

/**
 * Builds a Meta API message payload for a template send.
 * @param {string} templateType
 * @param {string[]} params  positional body parameters
 * @param {string} recipientPhone
 * @returns {Promise<object>} Meta API message object
 */
async function buildMessagePayload(templateType, params, recipientPhone) {
  const template = await getTemplate(templateType);

  const components = [];
  if (params && params.length > 0) {
    components.push({
      type: 'body',
      parameters: params.map((p) => ({ type: 'text', text: String(p) })),
    });
  }

  if (template.button_config) {
    const buttons = Array.isArray(template.button_config) ? template.button_config : [];
    buttons.forEach((btn, idx) => {
      components.push({
        type: 'button',
        sub_type: btn.type || 'url',
        index: String(idx),
        parameters: btn.parameters || [],
      });
    });
  }

  return {
    messaging_product: 'whatsapp',
    to: recipientPhone,
    type: 'template',
    template: {
      name: template.template_name,
      language: { code: template.language },
      components,
    },
  };
}

/**
 * Returns a plain-text fallback message for copy-paste in fallback mode.
 * @param {string} templateType
 * @param {string[]} params
 * @returns {string}
 */
function buildFallbackText(templateType, params) {
  const fn = FALLBACK_TEXTS[templateType];
  if (!fn) return `[${templateType}] ${params.join(', ')}`;
  return fn(params);
}

/**
 * Syncs templates from Meta into the WhatsappTemplate table.
 * @param {string} accessToken  decrypted system token
 */
async function syncTemplatesFromMeta(accessToken) {
  const wabaId = process.env.WABA_ID;
  if (!wabaId) {
    logger.error('[TemplateManager] WABA_ID not set — cannot sync templates');
    return;
  }

  const response = await axios.get(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { limit: 100 },
    }
  );

  const templates = response.data?.data ?? [];
  let approved = 0;
  let rejected = 0;

  for (const t of templates) {
    await prisma.whatsappTemplate.upsert({
      where: { template_name_language: { template_name: t.name, language: t.language } },
      update: {
        status: t.status.toLowerCase(),
        meta_template_id: t.id,
        body_text: t.components?.find((c) => c.type === 'BODY')?.text ?? '',
        rejection_reason: t.rejected_reason ?? null,
        updated_at: new Date(),
      },
      create: {
        template_name: t.name,
        template_type: t.name,  // caller can update template_type manually
        language: t.language,
        meta_template_id: t.id,
        status: t.status.toLowerCase(),
        body_text: t.components?.find((c) => c.type === 'BODY')?.text ?? '',
        rejection_reason: t.rejected_reason ?? null,
      },
    });

    if (t.status === 'APPROVED') approved++;
    if (t.status === 'REJECTED') rejected++;
  }

  logger.info('[TemplateManager] syncTemplatesFromMeta complete', {
    total: templates.length,
    approved,
    rejected,
  });
}

module.exports = { getTemplate, buildMessagePayload, buildFallbackText, syncTemplatesFromMeta };
