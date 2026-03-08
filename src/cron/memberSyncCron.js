'use strict';

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { syncGymMembers } = require('../services/sync.service');

/**
 * Fetches all active, subscription-valid gyms and runs syncGymMembers for each.
 * Failures are isolated per gym — one gym's error does not abort others.
 */
async function syncAllGymMembers() {
  const now = new Date();
  logger.info(`[memberSyncCron] Run started at ${now.toISOString()}`);

  let gyms;
  try {
    gyms = await prisma.gym.findMany({
      where: {
        status: 'active',
        OR: [
          { subscription_expires_at: null },
          { subscription_expires_at: { gt: now } },
        ],
      },
      select: { id: true, name: true },
    });
  } catch (err) {
    logger.error('[memberSyncCron] Failed to fetch gyms. Aborting run.', {
      message: err.message,
    });
    return;
  }

  if (gyms.length === 0) {
    logger.info('[memberSyncCron] No active gyms found. Exiting.');
    return;
  }

  logger.info(`[memberSyncCron] Syncing ${gyms.length} gym(s).`);

  for (const gym of gyms) {
    try {
      const stats = await syncGymMembers(gym.id);

      if (stats === null) {
        logger.warn(`[memberSyncCron] gym_id=${gym.id} "${gym.name}": not found in DB, skipped.`);
        continue;
      }

      logger.info(
        `[memberSyncCron] gym_id=${gym.id} "${gym.name}": ` +
        `totalRows=${stats.totalRows}, inserted=${stats.inserted}, updated=${stats.updated}, ` +
        `skipped=${stats.skipped}, deactivated=${stats.deactivated}`
      );
    } catch (err) {
      logger.error(
        `[memberSyncCron] Error syncing gym_id=${gym.id} "${gym.name}". Skipping.`,
        { message: err.message, stack: err.stack }
      );
    }
  }

  logger.info('[memberSyncCron] Run complete.');
}

function initMemberSyncCron() {
  cron.schedule('0 2 * * *', syncAllGymMembers, {
    timezone: 'Asia/Kolkata',
  });

  logger.info('[memberSyncCron] Scheduled — daily at 02:00 IST.');
}

module.exports = { initMemberSyncCron, syncAllGymMembers };
