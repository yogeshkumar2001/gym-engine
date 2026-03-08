'use strict';

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { syncGymMembers } = require('../services/sync.service');

const MAX_RETRIES   = 3;
const RETRY_DELAYS  = [0, 30_000, 60_000]; // ms before each attempt (0 = immediate first try)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Syncs one gym with up to MAX_RETRIES attempts and exponential-ish backoff.
 * Returns stats on success, throws on final failure.
 */
async function syncGymWithRetry(gym) {
  let lastErr;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (RETRY_DELAYS[attempt] > 0) {
      logger.info(
        `[memberSyncCron] gym_id=${gym.id} "${gym.name}": ` +
        `retry ${attempt}/${MAX_RETRIES - 1} in ${RETRY_DELAYS[attempt] / 1000}s…`
      );
      await sleep(RETRY_DELAYS[attempt]);
    }

    try {
      const stats = await syncGymMembers(gym.id);
      return stats; // success — bubble up
    } catch (err) {
      lastErr = err;
      logger.warn(
        `[memberSyncCron] gym_id=${gym.id} "${gym.name}": ` +
        `attempt ${attempt + 1} failed — ${err.message}`
      );
    }
  }

  throw lastErr; // all attempts exhausted
}

// Module-level lock — prevents concurrent runs if the cron fires while the
// previous run is still executing (e.g. slow Sheet API on many gyms).
let _isRunning = false;

/**
 * Fetches all active, subscription-valid gyms and runs syncGymMembers for each.
 * Each gym is retried up to MAX_RETRIES times before marking as failed.
 * Failures are isolated per gym — one gym's error does not abort others.
 */
async function syncAllGymMembers() {
  if (_isRunning) {
    logger.warn('[memberSyncCron] Previous run still active — skipping this tick.');
    return;
  }
  _isRunning = true;
  try {
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
        const stats = await syncGymWithRetry(gym);

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
        // All retries exhausted — persist error so the owner sees it on the dashboard.
        logger.error(
          `[memberSyncCron] gym_id=${gym.id} "${gym.name}": all ${MAX_RETRIES} attempts failed. ` +
          `Persisting error.`,
          { message: err.message }
        );
        prisma.gym.update({
          where: { id: gym.id },
          data: { last_sync_error: err.message },
        }).catch(() => {});
      }
    }

    logger.info('[memberSyncCron] Run complete.');
  } finally {
    _isRunning = false;
  }
}

function initMemberSyncCron() {
  const task = cron.schedule('0 2 * * *', syncAllGymMembers, {
    timezone: 'Asia/Kolkata',
  });

  logger.info('[memberSyncCron] Scheduled — daily at 02:00 IST.');
  return task;
}

module.exports = { initMemberSyncCron, syncAllGymMembers };
