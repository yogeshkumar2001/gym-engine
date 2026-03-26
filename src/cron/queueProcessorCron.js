'use strict';

const cron = require('node-cron');
const logger = require('../config/logger');
const { processNextBatch } = require('../services/whatsapp/QueueProcessor');

/**
 * Fires every 30 seconds. Dequeues up to 10 queued WhatsApp messages
 * and sends them via the Meta Cloud API.
 *
 * Uses second-level cron syntax (6 fields) as supported by node-cron.
 */
const queueProcessorCron = cron.schedule(
  '*/30 * * * * *',
  async () => {
    try {
      await processNextBatch();
    } catch (err) {
      logger.error('[queueProcessorCron] unhandled error', { error: err.message, stack: err.stack });
    }
  },
  { scheduled: false, timezone: 'Asia/Kolkata' }
);

module.exports = queueProcessorCron;
