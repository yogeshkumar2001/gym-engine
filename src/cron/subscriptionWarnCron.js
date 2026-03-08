'use strict';

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../config/logger');

const WARN_DAYS = 7; // start warning this many days before expiry

/**
 * Finds active gyms whose subscription expires within the next WARN_DAYS days
 * and logs a structured warning for each one.
 *
 * This gives the super-admin visibility into upcoming expirations and ensures
 * the gym owner sees the expiry banner on their dashboard (via health response).
 * When a WhatsApp owner-alert template is available, the send call can be
 * added inside the loop without changing the rest of the logic.
 */
async function warnExpiringSubscriptions() {
  const now = new Date();
  const warnCutoff = new Date(now.getTime() + WARN_DAYS * 24 * 60 * 60 * 1000);

  logger.info(`[subscriptionWarnCron] Run started at ${now.toISOString()}`);

  let gyms;
  try {
    gyms = await prisma.gym.findMany({
      where: {
        status: 'active',
        subscription_expires_at: {
          gt: now,        // not yet expired
          lte: warnCutoff, // expires within WARN_DAYS
        },
      },
      select: {
        id: true,
        name: true,
        subscription_expires_at: true,
      },
    });
  } catch (err) {
    logger.error('[subscriptionWarnCron] Failed to fetch gyms.', { message: err.message });
    return;
  }

  if (gyms.length === 0) {
    logger.info('[subscriptionWarnCron] No subscriptions expiring soon.');
    return;
  }

  for (const gym of gyms) {
    const msLeft = new Date(gym.subscription_expires_at) - now;
    const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));

    logger.warn(
      `[subscriptionWarnCron] gym_id=${gym.id} "${gym.name}": ` +
      `subscription expires in ${daysLeft} day(s) (${gym.subscription_expires_at.toISOString()}).`
    );

    // TODO: send WhatsApp message to gym owner's phone once
    //       an "subscription_expiry_warning" template is approved in Meta.
  }

  logger.info(`[subscriptionWarnCron] ${gyms.length} gym(s) warned.`);
}

function initSubscriptionWarnCron() {
  // Run daily at 08:00 IST — before the expiry cron fires at 09:00
  const task = cron.schedule('0 8 * * *', warnExpiringSubscriptions, {
    timezone: 'Asia/Kolkata',
  });

  logger.info('[subscriptionWarnCron] Scheduled — daily at 08:00 IST.');
  return task;
}

module.exports = { initSubscriptionWarnCron, warnExpiringSubscriptions };
