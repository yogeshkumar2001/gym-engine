'use strict';

/**
 * One-time migration: create WhatsappConfig rows for all existing gyms
 * that don't have one yet.
 *
 * Copies per-gym discount/UPI settings into the new config table and
 * derives payment_mode from the gym's services JSON.
 *
 * Run once after deploying Phase 1:
 *   node scripts/migrateWhatsappConfig.js
 *
 * Safe to re-run — skips gyms that already have a WhatsappConfig row.
 */

require('dotenv').config();

const prisma = require('../src/lib/prisma');
const logger = require('../src/config/logger');

function derivePaymentMode(services, upiId) {
  const parsed = typeof services === 'string' ? JSON.parse(services) : services;

  if (parsed?.payments === true) return 'razorpay';
  if (upiId)                     return 'upi_only';
  return 'cash_only';
}

async function run() {
  logger.info('[migrateWhatsappConfig] starting');

  const gyms = await prisma.gym.findMany({
    where: {
      status: { in: ['active', 'onboarding'] },
      whatsapp_config: null,
    },
    select: {
      id: true,
      upi_id: true,
      services: true,
      recovery_discount_percent: true,
      reactivation_discount_percent: true,
    },
  });

  logger.info(`[migrateWhatsappConfig] ${gyms.length} gyms need a WhatsappConfig`);

  let created = 0;
  let failed  = 0;

  for (const gym of gyms) {
    try {
      const payment_mode = derivePaymentMode(gym.services, gym.upi_id);

      await prisma.whatsappConfig.create({
        data: {
          gym_id:               gym.id,
          upi_id:               gym.upi_id ?? null,
          recovery_discount_pct: gym.recovery_discount_percent ?? 5.0,
          winback_discount_pct:  gym.reactivation_discount_percent ?? 10.0,
          payment_mode,
          razorpay_enabled:      payment_mode === 'razorpay',
        },
      });

      created++;
      logger.info(`[migrateWhatsappConfig] created config for gym ${gym.id}`, { payment_mode });
    } catch (err) {
      failed++;
      logger.error(`[migrateWhatsappConfig] failed for gym ${gym.id}`, { error: err.message });
    }
  }

  logger.info(`[migrateWhatsappConfig] done — created: ${created}, failed: ${failed}`);
}

run()
  .catch((err) => {
    logger.error('[migrateWhatsappConfig] fatal error', { error: err.message, stack: err.stack });
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
