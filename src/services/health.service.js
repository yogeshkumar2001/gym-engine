'use strict';

const prisma = require('../lib/prisma');
const { getTargetDayWindow } = require('../utils/dateUtils');

async function getGymHealth(gymId) {
  const { startOfTargetDay: startOfToday, endOfTargetDay: endOfToday } = getTargetDayWindow(0);

  const [gymInfo, renewalGroups, todayRevenue, failedWhatsappCount] = await Promise.all([
    prisma.gym.findUnique({
      where: { id: gymId },
      select: { status: true, last_health_check_at: true, last_error_message: true },
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
  }).catch(() => {});

  // Build renewals map from groupBy result
  const renewals = {};
  for (const group of renewalGroups) {
    renewals[group.status] = group._count.id;
  }

  return {
    status: gymInfo?.status ?? null,
    last_health_check_at: gymInfo?.last_health_check_at ?? null,
    last_error_message: gymInfo?.last_error_message ?? null,
    renewals,
    today_revenue: todayRevenue._sum.amount ?? 0,
    failed_whatsapp_count: failedWhatsappCount,
  };
}

module.exports = { getGymHealth };
