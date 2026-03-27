'use strict';

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { alertFounder } = require('../services/whatsapp/TokenManager');

/**
 * Runs daily at 06:00 IST.
 * Finds all dead messages created in the last 24 hours, groups by gym,
 * logs a structured error, and alerts the founder via WhatsApp.
 */
async function runDeadLetterCheck() {
  logger.info('[deadLetterCron] starting');

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const dead = await prisma.messageQueue.findMany({
    where: { status: 'dead', created_at: { gt: cutoff } },
    select: { gym_id: true, template_type: true, error_code: true },
  });

  if (dead.length === 0) {
    logger.info('[deadLetterCron] no dead messages in last 24h');
    return;
  }

  // Group by gym_id
  const byGym = new Map();
  for (const row of dead) {
    if (!byGym.has(row.gym_id)) {
      byGym.set(row.gym_id, { count: 0, template_types: new Set(), error_codes: new Set() });
    }
    const g = byGym.get(row.gym_id);
    g.count++;
    g.template_types.add(row.template_type);
    if (row.error_code) g.error_codes.add(row.error_code);
  }

  for (const [gym_id, { count, template_types, error_codes }] of byGym) {
    const types = [...template_types].join(', ');
    const codes = [...error_codes].join(', ') || 'none';

    logger.error('[deadLetterCron] dead messages detected', {
      gym_id,
      count,
      template_types: types,
      error_codes: codes,
    });

    await alertFounder(
      `Dead letters: gym ${gym_id} has ${count} failed message(s) in last 24h. ` +
      `Types: ${types}. Error codes: ${codes}.`
    );
  }

  logger.info('[deadLetterCron] complete', {
    total_dead: dead.length,
    gyms_affected: byGym.size,
  });
}

function initDeadLetterCron() {
  const task = cron.schedule('0 6 * * *', runDeadLetterCheck, {
    timezone: 'Asia/Kolkata',
  });

  logger.info('[deadLetterCron] scheduled — daily at 06:00 IST');
  return task;
}

module.exports = { initDeadLetterCron, runDeadLetterCheck };
