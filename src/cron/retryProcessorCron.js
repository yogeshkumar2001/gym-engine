'use strict';

const cron = require('node-cron');
const logger = require('../config/logger');
const { retryFailed } = require('../services/whatsapp/QueueProcessor');

/**
 * Fires every 5 minutes. Finds failed MessageQueue rows whose next_retry_at
 * has passed and resets them to 'queued' for the next processNextBatch run.
 */
const retryProcessorCron = cron.schedule(
  '*/5 * * * *',
  async () => {
    try {
      await retryFailed();
    } catch (err) {
      logger.error('[retryProcessorCron] unhandled error', { error: err.message, stack: err.stack });
    }
  },
  { scheduled: false, timezone: 'Asia/Kolkata' }
);

module.exports = retryProcessorCron;
