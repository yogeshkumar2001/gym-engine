'use strict';

const prisma = require('../lib/prisma');

/**
 * getForecast(gymId, days = 30)
 *
 * Revenue forecast for the next `days` days.
 *
 * confirmed_revenue     — paid renewals this calendar month
 * pending_renewal_count — link_generated renewals awaiting payment
 * pending_renewal_value — total amount of those renewals
 * conversion_rate       — historical paid / (paid + failed + dead) over last 90 days
 *                         (defaults to 0.70 if no history exists)
 * expected_from_pending — pending_renewal_value × conversion_rate
 * at_risk_revenue       — pending_renewal_value × (1 − conversion_rate)
 * upcoming_members      — active members expiring in next `days` days with no active renewal
 * upcoming_members_value — sum of their plan_amount (potential new pipeline)
 * expected_from_upcoming — upcoming_members_value × conversion_rate
 * total_expected_revenue — confirmed + expected_from_pending + expected_from_upcoming
 */
async function getForecast(gymId, days = 30) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const futureDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  // Run sequentially to stay within pool limit of 5 — crons may hold connections concurrently
  const confirmedResult = await prisma.renewal.aggregate({
    where: {
      gym_id: gymId,
      status: 'paid',
      updated_at: { gte: monthStart },
    },
    _sum: { amount: true },
    _count: { id: true },
  });

  const pendingRenewals = await prisma.renewal.findMany({
    where: {
      gym_id: gymId,
      status: 'link_generated',
    },
    select: { id: true, amount: true },
  });

  const historicalGroups = await prisma.renewal.groupBy({
    by: ['status'],
    where: {
      gym_id: gymId,
      status: { in: ['paid', 'failed', 'dead'] },
      updated_at: { gte: ninetyDaysAgo },
    },
    _count: { id: true },
  });

  const upcomingMembers = await prisma.member.findMany({
    where: {
      gym_id: gymId,
      status: 'active',
      expiry_date: { gte: now, lte: futureDate },
      renewals: {
        none: {
          status: { in: ['pending', 'processing_link', 'link_generated', 'paid'] },
        },
      },
    },
    select: { id: true, name: true, plan_amount: true, expiry_date: true },
  });

  // Build conversion rate from historical terminal states
  const statusCounts = {};
  for (const row of historicalGroups) {
    statusCounts[row.status] = row._count.id;
  }
  const paidCount = statusCounts['paid'] || 0;
  const lostCount = (statusCounts['failed'] || 0) + (statusCounts['dead'] || 0);
  const totalSample = paidCount + lostCount;
  // Default to 70% if there is not enough historical data
  const conversionRate = totalSample > 0 ? paidCount / totalSample : 0.7;

  const confirmedRevenue = confirmedResult._sum.amount || 0;
  const confirmedCount = confirmedResult._count.id;

  const pendingCount = pendingRenewals.length;
  const pendingValue = pendingRenewals.reduce((s, r) => s + r.amount, 0);

  const upcomingCount = upcomingMembers.length;
  const upcomingValue = upcomingMembers.reduce((s, m) => s + m.plan_amount, 0);

  const expectedFromPending = pendingValue * conversionRate;
  const atRiskRevenue = pendingValue * (1 - conversionRate);
  const expectedFromUpcoming = upcomingValue * conversionRate;
  const totalExpected = confirmedRevenue + expectedFromPending + expectedFromUpcoming;

  const round2 = (n) => Math.round(n * 100) / 100;

  return {
    forecast_days: days,
    confirmed_revenue: round2(confirmedRevenue),
    confirmed_count: confirmedCount,
    pending_renewal_count: pendingCount,
    pending_renewal_value: round2(pendingValue),
    conversion_rate: Math.round(conversionRate * 1000) / 1000,
    expected_from_pending: round2(expectedFromPending),
    at_risk_revenue: round2(atRiskRevenue),
    upcoming_members_count: upcomingCount,
    upcoming_members_value: round2(upcomingValue),
    expected_from_upcoming: round2(expectedFromUpcoming),
    total_expected_revenue: round2(totalExpected),
    historical_sample_size: totalSample,
  };
}

module.exports = { getForecast };
