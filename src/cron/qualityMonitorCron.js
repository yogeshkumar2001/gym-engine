'use strict';

const axios = require('axios');
const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const TokenManager = require('../services/whatsapp/TokenManager');

const GRAPH_API_VERSION = 'v22.0';

/**
 * Runs daily at 09:00 IST.
 * Polls Meta for the quality_rating of every active phone number and
 * updates the WhatsappAccount row if it has changed.
 * Alerts the founder whenever a number drops to RED.
 */
async function runQualityMonitor() {
  logger.info('[qualityMonitorCron] starting');
  const startTime = Date.now();

  let accessToken;
  try {
    const tokenData = await TokenManager.getActiveToken();
    accessToken = tokenData.access_token;
  } catch (err) {
    logger.error('[qualityMonitorCron] cannot get active token — aborting', { error: err.message });
    return;
  }

  const accounts = await prisma.whatsappAccount.findMany({
    where: { status: 'active' },
    select: { id: true, gym_id: true, phone_number_id: true, quality_rating: true },
  });

  if (accounts.length === 0) {
    logger.info('[qualityMonitorCron] no active accounts to check');
    return;
  }

  let updated = 0;
  let redAlerts = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      const response = await axios.get(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${account.phone_number_id}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { fields: 'quality_rating,display_phone_number,verified_name' },
        }
      );

      const newRating = response.data?.quality_rating ?? null;

      if (newRating !== account.quality_rating) {
        await prisma.whatsappAccount.update({
          where: { id: account.id },
          data: { quality_rating: newRating },
        });

        logger.info('[qualityMonitorCron] quality_rating changed', {
          gym_id: account.gym_id,
          phone_number_id: account.phone_number_id,
          old_rating: account.quality_rating,
          new_rating: newRating,
        });

        updated++;
      }

      if (newRating === 'RED') {
        logger.error('[qualityMonitorCron] RED quality rating detected', {
          gym_id: account.gym_id,
          phone_number_id: account.phone_number_id,
        });

        await TokenManager.alertFounder(
          `Quality alert: gym ${account.gym_id} phone number ${account.phone_number_id} has RED quality rating. ` +
          `Template sending may be restricted by Meta.`
        );

        redAlerts++;
      }
    } catch (err) {
      logger.error('[qualityMonitorCron] failed to check account', {
        gym_id: account.gym_id,
        phone_number_id: account.phone_number_id,
        error: err.message,
      });
      failed++;
    }
  }

  logger.info('[qualityMonitorCron] complete', {
    total: accounts.length,
    updated,
    red_alerts: redAlerts,
    failed,
    duration_ms: Date.now() - startTime,
  });
}

function initQualityMonitorCron() {
  const task = cron.schedule('0 9 * * *', runQualityMonitor, {
    timezone: 'Asia/Kolkata',
  });

  logger.info('[qualityMonitorCron] scheduled — daily at 09:00 IST');
  return task;
}

module.exports = { initQualityMonitorCron, runQualityMonitor };
