'use strict';

const cron = require('node-cron');
const axios = require('axios');
const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { generateDailyDigest, markFallbackSent } = require('../services/whatsapp/FallbackGenerator');
const TokenManager = require('../services/whatsapp/TokenManager');

const GRAPH_API_VERSION = 'v22.0';

/**
 * Returns the phone_number_id to send FROM.
 * Prefers SYSTEM_PHONE_NUMBER_ID env var; falls back to the first active
 * non-fallback WhatsappAccount if that var is absent.
 *
 * @returns {Promise<string|null>}
 */
async function getSystemPhoneNumberId() {
  if (process.env.SYSTEM_PHONE_NUMBER_ID) return process.env.SYSTEM_PHONE_NUMBER_ID;

  const account = await prisma.whatsappAccount.findFirst({
    where: { status: 'active', fallback_mode: false },
    select: { phone_number_id: true },
  });

  return account?.phone_number_id ?? null;
}

/**
 * Sends today's pending copy-paste digest to every gym still in fallback mode.
 * - Fetches all queued messages created today for renewal/recovery/winback.
 * - POSTs a plain-text message to the gym owner's personal phone via Meta API.
 * - Marks those queue entries as 'sent' so they don't re-appear tomorrow.
 */
async function runFallbackDigest() {
  logger.info('[fallbackDigestCron] starting');
  const startTime = Date.now();

  const gyms = await prisma.gym.findMany({
    where: {
      whatsapp_account: { is: { fallback_mode: true } },
      status: { in: ['active', 'onboarding'] },
    },
    select: { id: true, owner_phone: true },
  });

  if (gyms.length === 0) {
    logger.info('[fallbackDigestCron] no gyms in fallback mode — nothing to do');
    return;
  }

  let access_token;
  try {
    ({ access_token } = await TokenManager.getActiveToken());
  } catch (err) {
    logger.error('[fallbackDigestCron] cannot get system token — aborting', { error: err.message });
    return;
  }

  const phoneNumberId = await getSystemPhoneNumberId();
  if (!phoneNumberId) {
    logger.error('[fallbackDigestCron] no system phone_number_id available — aborting');
    return;
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const gym of gyms) {
    try {
      const { digest_text, message_count, gym_owner_phone } = await generateDailyDigest(gym.id);

      if (message_count === 0) {
        skipped++;
        continue;
      }

      if (!gym_owner_phone) {
        logger.warn('[fallbackDigestCron] gym has no owner_phone — skipping', { gym_id: gym.id });
        skipped++;
        continue;
      }

      await axios.post(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: gym_owner_phone,
          type: 'text',
          text: { body: digest_text },
        },
        {
          headers: {
            Authorization: `Bearer ${access_token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      await markFallbackSent(gym.id);
      sent++;

      logger.info('[fallbackDigestCron] digest sent', { gym_id: gym.id, message_count });
    } catch (err) {
      failed++;
      logger.error('[fallbackDigestCron] failed for gym', { gym_id: gym.id, error: err.message });
    }
  }

  logger.info('[fallbackDigestCron] complete', { total: gyms.length, sent, skipped, failed, duration_ms: Date.now() - startTime });
}

function initFallbackDigestCron() {
  const task = cron.schedule('0 9 * * *', runFallbackDigest, {
    timezone: 'Asia/Kolkata',
  });

  logger.info('[fallbackDigestCron] scheduled — daily at 09:00 IST');
  return task;
}

module.exports = { initFallbackDigestCron, runFallbackDigest };
