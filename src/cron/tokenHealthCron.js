'use strict';

const cron = require('node-cron');
const logger = require('../config/logger');
const { healthCheck } = require('../services/whatsapp/TokenManager');

/**
 * Fires every 6 hours. Verifies the WABA system token against Meta's /me
 * endpoint, updates last_verified, and alerts the founder if the token is
 * expiring within 7 days or has been revoked (401).
 */
const tokenHealthCron = cron.schedule(
  '0 */6 * * *',
  async () => {
    try {
      await healthCheck();
    } catch (err) {
      logger.error('[tokenHealthCron] unhandled error', { error: err.message, stack: err.stack });
    }
  },
  { scheduled: false, timezone: 'Asia/Kolkata' }
);

module.exports = tokenHealthCron;
