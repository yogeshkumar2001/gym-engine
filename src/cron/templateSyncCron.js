'use strict';

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const TokenManager = require('../services/whatsapp/TokenManager');
const TemplateManager = require('../services/whatsapp/TemplateManager');

/**
 * Runs daily at 03:00 IST.
 * Syncs all WhatsApp templates from Meta into the WhatsappTemplate table.
 * Alerts the founder if any template is in rejected or paused status.
 */
async function runTemplateSync() {
  logger.info('[templateSyncCron] starting');
  const startTime = Date.now();

  let accessToken;
  try {
    const tokenData = await TokenManager.getActiveToken();
    accessToken = tokenData.access_token;
  } catch (err) {
    logger.error('[templateSyncCron] cannot get active token — aborting', { error: err.message });
    return;
  }

  try {
    await TemplateManager.syncTemplatesFromMeta(accessToken);
  } catch (err) {
    logger.error('[templateSyncCron] syncTemplatesFromMeta failed', { error: err.message });
    await TokenManager.alertFounder(
      `Template sync failed: ${err.message}. WhatsApp templates may be out of sync.`
    );
    return;
  }

  // Check for any rejected or paused templates and alert founder
  const problematic = await prisma.whatsappTemplate.findMany({
    where: { status: { in: ['rejected', 'paused'] } },
    select: { template_name: true, status: true, rejection_reason: true },
  });

  if (problematic.length > 0) {
    const lines = problematic.map(
      (t) => `${t.template_name} [${t.status}]${t.rejection_reason ? ': ' + t.rejection_reason : ''}`
    );

    logger.error('[templateSyncCron] problematic templates detected', {
      count: problematic.length,
      templates: lines,
    });

    await TokenManager.alertFounder(
      `Template alert: ${problematic.length} template(s) need attention — ${lines.join('; ')}`
    );
  }

  logger.info('[templateSyncCron] complete', {
    problematic_count: problematic.length,
    duration_ms: Date.now() - startTime,
  });
}

function initTemplateSyncCron() {
  const task = cron.schedule('0 3 * * *', runTemplateSync, {
    timezone: 'Asia/Kolkata',
  });

  logger.info('[templateSyncCron] scheduled — daily at 03:00 IST');
  return task;
}

module.exports = { initTemplateSyncCron, runTemplateSync };
