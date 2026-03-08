'use strict';

const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { getTargetDayWindow } = require('../utils/dateUtils');

async function getGymHealth(gymId) {
  const { startOfTargetDay: startOfToday, endOfTargetDay: endOfToday } = getTargetDayWindow(0);

  const [gymInfo, renewalGroups, todayRevenue, failedWhatsappCount] = await Promise.all([
    prisma.gym.findUnique({
      where: { id: gymId },
      select: { status: true, last_health_check_at: true, last_error_message: true, last_synced_at: true, last_sync_member_count: true, last_sync_error: true, razorpay_valid: true, whatsapp_valid: true, sheet_valid: true, subscription_expires_at: true },
    }),
    prisma.renewal.groupBy({
      by: ['status'],
      where: { gym_id: gymId },
      _count: { id: true },
    }),
    prisma.renewal.aggregate({
      _sum: { amount: true },
      where: {
        gym_id: gymId,
        status: 'paid',
        updated_at: { gte: startOfToday, lte: endOfToday },
      },
    }),
    prisma.renewal.count({
      where: { gym_id: gymId, whatsapp_status: 'failed' },
    }),
  ]);

  // Update last health check timestamp (fire-and-forget, don't block response)
  prisma.gym.update({
    where: { id: gymId },
    data: { last_health_check_at: new Date() },
  }).catch((err) => {
    logger.warn('[health.service] Failed to update last_health_check_at', { gym_id: gymId, message: err.message });
  });

  // Build renewals map from groupBy result
  const renewals = {};
  for (const group of renewalGroups) {
    renewals[group.status] = group._count.id;
  }

  return {
    status: gymInfo?.status ?? null,
    last_health_check_at: gymInfo?.last_health_check_at ?? null,
    last_error_message: gymInfo?.last_error_message ?? null,
    last_synced_at: gymInfo?.last_synced_at ?? null,
    last_sync_member_count: gymInfo?.last_sync_member_count ?? null,
    last_sync_error: gymInfo?.last_sync_error ?? null,
    razorpay_valid: gymInfo?.razorpay_valid ?? null,
    whatsapp_valid: gymInfo?.whatsapp_valid ?? null,
    sheet_valid: gymInfo?.sheet_valid ?? null,
    subscription_expires_at: gymInfo?.subscription_expires_at ?? null,
    renewals,
    today_revenue: todayRevenue._sum.amount ?? 0,
    failed_whatsapp_count: failedWhatsappCount,
  };
}

module.exports = { getGymHealth };
