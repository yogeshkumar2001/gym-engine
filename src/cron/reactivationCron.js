'use strict';

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { decryptGymCredentials } = require('../utils/encryption');
const { detectChurnedMembers, recordReactivationCampaign } = require('../services/reactivationService');
const { sendReactivationOffer } = require('../services/whatsappService');

/**
 * Processes reactivation campaigns for one gym.
 *
 * For each churned member:
 *   1. Send a WhatsApp win-back offer with a discount.
 *   2. Record the ReactivationCampaign row.
 *   3. Update member.reactivation_sent_at.
 *
 * Errors are isolated per member — one failed send does not skip the rest.
 *
 * @param {object} gym  — decrypted credentials included
 */
async function processGymReactivation(gym) {
  const config = gym.whatsapp_config;

  // Skip if winback is disabled in config
  if (config && !config.winback_enabled) {
    logger.info(`[reactivationCron] gym ${gym.id}: winback_enabled=false — skipping.`);
    return;
  }

  const winbackDelayDays = config?.winback_delay_days ?? 30;
  const discountPct = config?.winback_discount_pct != null
    ? Number(config.winback_discount_pct)
    : (gym.reactivation_discount_percent ?? 10);
  const maxAttempts = config?.winback_max_attempts ?? 2;

  const members = await detectChurnedMembers(gym.id, { delayDays: winbackDelayDays });

  if (members.length === 0) {
    logger.debug(`[reactivationCron] No churned members for gym ${gym.id}`);
    return;
  }

  logger.info(`[reactivationCron] gym ${gym.id} — ${members.length} churned member(s) found`);

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const member of members) {
    try {
      // Enforce winback_max_attempts
      const campaignCount = await prisma.reactivationCampaign.count({
        where: { gym_id: gym.id, member_id: member.id },
      });

      if (campaignCount >= maxAttempts) {
        logger.debug(`[reactivationCron] Max attempts (${maxAttempts}) reached for member ${member.id} — skipping.`);
        skipped++;
        continue;
      }

      await sendReactivationOffer(gym, member, discountPct);
      await recordReactivationCampaign(gym.id, member.id, discountPct);
      sent++;
      logger.info(`[reactivationCron] Reactivation offer sent — gym ${gym.id}, member ${member.id}`);
    } catch (err) {
      failed++;
      logger.error(`[reactivationCron] Failed for member ${member.id}`, { error: err.message, gym_id: gym.id });
    }
  }

  logger.info(`[reactivationCron] gym ${gym.id} done — sent: ${sent}, skipped: ${skipped}, failed: ${failed}`);
}

/**
 * Main job: runs over all active, subscribed gyms.
 * Gyms are processed sequentially to stay within the 5-connection pool limit.
 */
async function runReactivationJob() {
  logger.info('[reactivationCron] Starting weekly reactivation job');

  const now = new Date();

  // Fetch only active gyms whose subscription has not expired
  const gyms = await prisma.gym.findMany({
    where: {
      status: 'active',
      OR: [
        { subscription_expires_at: null },
        { subscription_expires_at: { gt: now } },
      ],
    },
    select: {
      id: true,
      name: true,
      whatsapp_phone_number_id: true,
      whatsapp_access_token: true,
      owner_phone: true,
      reactivation_discount_percent: true,
      whatsapp_config: true,
    },
  });

  logger.info(`[reactivationCron] Processing ${gyms.length} active gym(s)`);

  for (const gym of gyms) {
    try {
      decryptGymCredentials(gym);
      await processGymReactivation(gym);
    } catch (err) {
      logger.error(`[reactivationCron] Fatal error for gym ${gym.id}`, { error: err.message });
    }
  }

  logger.info('[reactivationCron] Weekly reactivation job complete');
}

/**
 * Schedules the reactivation cron.
 * Runs every Monday at 10:00 IST.
 */
function initReactivationCron() {
  // "0 10 * * 1" = minute 0, hour 10, any day-of-month, any month, Monday
  const task = cron.schedule('0 10 * * 1', runReactivationJob, {
    timezone: 'Asia/Kolkata',
  });

  logger.info('[reactivationCron] Scheduled — every Monday at 10:00 IST');
  return task;
}

module.exports = { initReactivationCron, runReactivationJob };
