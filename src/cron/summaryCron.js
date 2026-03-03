'use strict';

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { getTargetDayWindow } = require('../utils/dateUtils');
const { sendDailySummary } = require('../services/whatsappService');
const { decryptGymCredentials } = require('../utils/encryption');

/**
 * Computes today's stats for one gym and sends a WhatsApp daily summary
 * to the gym owner.
 *
 * Queries run in parallel for performance:
 *   - remindersSent  : renewals where whatsapp_sent_at falls within today (UTC)
 *   - renewalsPaid   : renewals where status='paid' AND updated_at within today
 *   - revenueRecovered: sum of amount for paid renewals updated today
 *   - pendingCount   : renewals in active pre-payment statuses
 *
 * @param {{ id, name, whatsapp_phone_number_id, whatsapp_access_token, owner_phone }} gym
 * @param {Date} startOfToday
 * @param {Date} endOfToday
 */
async function processGymSummary(gym, startOfToday, endOfToday) {
  const todayFilter = { gte: startOfToday, lte: endOfToday };

  const [remindersSent, renewalsPaid, revenueResult, pendingCount] = await Promise.all([
    prisma.renewal.count({
      where: {
        gym_id: gym.id,
        whatsapp_sent_at: todayFilter,
      },
    }),
    prisma.renewal.count({
      where: {
        gym_id: gym.id,
        status: 'paid',
        updated_at: todayFilter,
      },
    }),
    prisma.renewal.aggregate({
      _sum: { amount: true },
      where: {
        gym_id: gym.id,
        status: 'paid',
        updated_at: todayFilter,
      },
    }),
    prisma.renewal.count({
      where: {
        gym_id: gym.id,
        status: { in: ['pending', 'link_generated'] },
      },
    }),
  ]);

  const rawRevenue = revenueResult._sum.amount ?? 0;
  const revenueRecovered = `₹${Number(rawRevenue).toFixed(2)}`;

  const stats = { remindersSent, renewalsPaid, revenueRecovered, pendingCount };

  logger.debug('[summaryCron] Gym stats computed', { gym_id: gym.id, ...stats });

  await sendDailySummary(gym, stats);

  logger.info('[summaryCron] Daily summary sent', { gym_id: gym.id, gym_name: gym.name, ...stats });
}

/**
 * Main cron handler.
 * Fetches all gyms, computes today's window once, then processes each gym
 * independently — one gym's failure does not affect others.
 */
async function sendDailySummaries() {
  const now = new Date();
  logger.info(`[summaryCron] Run started at ${now.toISOString()}`);

  // getTargetDayWindow(0) gives UTC boundaries for today
  const { startOfTargetDay: startOfToday, endOfTargetDay: endOfToday } = getTargetDayWindow(0);

  logger.debug('[summaryCron] Today window', {
    startOfToday: startOfToday.toISOString(),
    endOfToday: endOfToday.toISOString(),
  });

  let gyms;
  try {
    gyms = await prisma.gym.findMany({
      where: {
        status: 'active',
        // Mirrors the expiryCron subscription gate: skip gyms whose
        // subscription has lapsed (non-null date in the past).
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
      },
    });
    gyms = gyms.map(g => decryptGymCredentials(g));
  } catch (err) {
    logger.error('[summaryCron] Failed to fetch gyms. Aborting run.', {
      message: err.message,
      stack: err.stack,
    });
    return;
  }

  if (gyms.length === 0) {
    logger.info('[summaryCron] No gyms found. Exiting.');
    return;
  }

  logger.info(`[summaryCron] Processing ${gyms.length} gym(s).`);

  for (const gym of gyms) {
    try {
      await processGymSummary(gym, startOfToday, endOfToday);
    } catch (err) {
      const metaError = err.response?.data ? JSON.stringify(err.response.data) : null;
      logger.error(
        `[summaryCron] Error processing gym_id=${gym.id} "${gym.name}". Skipping. ` +
        `status=${err.response?.status ?? 'N/A'} meta=${metaError ?? err.message}`
      );
    }
  }

  logger.info('[summaryCron] Run complete.');
}

function initSummaryCron() {
  cron.schedule('0 20 * * *', sendDailySummaries, {
    timezone: 'Asia/Kolkata',
  });

  logger.info('[summaryCron] Scheduled — daily at 20:00 IST.');
}

module.exports = { initSummaryCron, sendDailySummaries };
