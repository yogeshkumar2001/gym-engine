'use strict';

const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');
const { buildFallbackText } = require('./TemplateManager');

const DIGEST_TRIGGER_TYPES = ['expiry_cron', 'recovery_engine', 'winback'];

/**
 * Generates a copy-paste WhatsApp digest for a gym in fallback mode.
 * Includes all queued messages created today for renewal/recovery/winback triggers.
 *
 * @param {number} gymId
 * @returns {Promise<{ digest_text: string, message_count: number, gym_owner_phone: string }>}
 */
async function generateDailyDigest(gymId) {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { owner_phone: true },
  });

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const messages = await prisma.messageQueue.findMany({
    where: {
      gym_id: gymId,
      status: 'queued',
      trigger_type: { in: DIGEST_TRIGGER_TYPES },
      created_at: { gte: todayStart },
    },
    orderBy: { created_at: 'asc' },
  });

  if (messages.length === 0) {
    return { digest_text: '', message_count: 0, gym_owner_phone: gym?.owner_phone ?? '' };
  }

  const lines = ['📋 *Today\'s Pending WhatsApp Messages* (Send manually)\n'];

  for (const msg of messages) {
    const params = Array.isArray(msg.template_params)
      ? msg.template_params
      : JSON.parse(msg.template_params ?? '[]');

    const text = buildFallbackText(msg.template_type, params);
    lines.push(`📱 *To:* ${msg.recipient_phone}`);
    lines.push(text);
    lines.push('─────────────────');
  }

  lines.push(`\nTotal: ${messages.length} messages pending`);

  const digest_text = lines.join('\n');

  logger.info('[FallbackGenerator] digest generated', {
    gym_id: gymId,
    message_count: messages.length,
  });

  return {
    digest_text,
    message_count: messages.length,
    gym_owner_phone: gym?.owner_phone ?? '',
  };
}

/**
 * Marks all today's queued fallback messages as 'sent' and updates
 * corresponding Renewal.whatsapp_status to 'fallback_sent'.
 *
 * @param {number} gymId
 */
async function markFallbackSent(gymId) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const messages = await prisma.messageQueue.findMany({
    where: {
      gym_id: gymId,
      status: 'queued',
      trigger_type: { in: DIGEST_TRIGGER_TYPES },
      created_at: { gte: todayStart },
    },
    select: { id: true, member_id: true },
  });

  if (messages.length === 0) return;

  const ids = messages.map((m) => m.id);
  const memberIds = [...new Set(messages.map((m) => m.member_id).filter(Boolean))];

  await prisma.messageQueue.updateMany({
    where: { id: { in: ids } },
    data: { status: 'sent', sent_at: new Date() },
  });

  if (memberIds.length > 0) {
    await prisma.renewal.updateMany({
      where: {
        gym_id: gymId,
        member_id: { in: memberIds },
        status: { in: ['pending', 'link_generated'] },
      },
      data: { whatsapp_status: 'fallback_sent' },
    });
  }

  logger.info('[FallbackGenerator] markFallbackSent complete', {
    gym_id: gymId,
    messages_marked: ids.length,
    members_affected: memberIds.length,
  });
}

module.exports = { generateDailyDigest, markFallbackSent };
