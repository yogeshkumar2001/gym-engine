'use strict';

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { checkRegistrationStatus } = require('../services/whatsapp/OnboardingService');

/**
 * Polls every 2 hours for WhatsappAccounts still in 'verifying' state.
 * Calls checkRegistrationStatus() for each — if the account has since been
 * approved by Meta (status='active' in DB), it auto-promotes the gym out of
 * fallback mode and enqueues the owner welcome notification.
 */
async function runOnboardingCheck() {
  logger.info('[onboardingCheckCron] starting');

  const accounts = await prisma.whatsappAccount.findMany({
    where: { status: 'verifying' },
    select: { gym_id: true },
  });

  if (accounts.length === 0) {
    logger.info('[onboardingCheckCron] no accounts pending verification — nothing to do');
    return;
  }

  let activated = 0;
  let stillPending = 0;
  let failed = 0;

  for (const { gym_id } of accounts) {
    try {
      const result = await checkRegistrationStatus(gym_id);

      if (result.status === 'active' && !result.fallback_mode) {
        activated++;
        logger.info('[onboardingCheckCron] gym activated', { gym_id });
      } else {
        stillPending++;
        logger.debug('[onboardingCheckCron] still verifying', { gym_id, status: result.status });
      }
    } catch (err) {
      failed++;
      logger.error('[onboardingCheckCron] failed for gym', { gym_id, error: err.message });
    }
  }

  logger.info('[onboardingCheckCron] complete', {
    total: accounts.length,
    activated,
    still_pending: stillPending,
    failed,
  });
}

function initOnboardingCheckCron() {
  const task = cron.schedule('0 */2 * * *', runOnboardingCheck, {
    timezone: 'Asia/Kolkata',
  });

  logger.info('[onboardingCheckCron] scheduled — every 2 hours');
  return task;
}

module.exports = { initOnboardingCheckCron, runOnboardingCheck };
