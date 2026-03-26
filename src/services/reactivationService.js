'use strict';

const prisma = require('../lib/prisma');

// Members who lapsed 30–180 days ago and have not been contacted in the last 30 days
// are candidates for a reactivation campaign.
const CHURN_MIN_DAYS = 30;
const CHURN_MAX_DAYS = 180;
const REACTIVATION_COOLDOWN_DAYS = 30;
const REACTIVATION_DISCOUNT_PERCENT = 10;
const OFFER_VALIDITY_DAYS = 7;

/**
 * Finds members of a gym who qualify for a reactivation campaign:
 *   - status = 'active' but expiry_date is 30–180 days in the past
 *   - No paid Renewal ever (or last paid renewal was before CHURN_MAX_DAYS ago)
 *   - Not contacted in the last REACTIVATION_COOLDOWN_DAYS days
 *
 * Queries run sequentially to respect the 5-connection pool limit.
 *
 * @param {number} gymId
 * @returns {Promise<Array>}
 */
async function detectChurnedMembers(gymId, { delayDays = CHURN_MIN_DAYS } = {}) {
  const now = new Date();
  const churnMinDate = new Date(now - delayDays * 24 * 60 * 60 * 1000);
  const churnMaxDate = new Date(now - CHURN_MAX_DAYS * 24 * 60 * 60 * 1000);
  const cooldownDate = new Date(now - REACTIVATION_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);

  return prisma.member.findMany({
    where: {
      gym_id: gymId,
      status: 'active',
      expiry_date: {
        lt: churnMinDate,   // expired at least delayDays days ago
        gt: churnMaxDate,   // not more than 180 days ago
      },
      // Not already contacted recently
      OR: [
        { reactivation_sent_at: null },
        { reactivation_sent_at: { lt: cooldownDate } },
      ],
      // No paid renewal exists
      renewals: { none: { status: 'paid' } },
    },
    select: {
      id: true,
      name: true,
      phone: true,
      plan_name: true,
      plan_amount: true,
      expiry_date: true,
    },
  });
}

/**
 * Marks a member as churned and records the reactivation campaign in DB.
 * Runs as two sequential updates to stay within pool limit.
 *
 * @param {number} gymId
 * @param {number} memberId
 * @param {number} discountPercent
 * @returns {Promise<object>} The created ReactivationCampaign record
 */
async function recordReactivationCampaign(gymId, memberId, discountPercent) {
  const now = new Date();
  const offerExpiry = new Date(now.getTime() + OFFER_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

  // Mark member as churned + record send timestamp
  await prisma.member.update({
    where: { id: memberId },
    data: {
      churned_at: now,
      reactivation_sent_at: now,
      reactivation_offer_percent: discountPercent,
    },
  });

  return prisma.reactivationCampaign.create({
    data: {
      gym_id: gymId,
      member_id: memberId,
      discount_percent: discountPercent,
      offer_expiry: offerExpiry,
      status: 'sent',
    },
  });
}

/**
 * Marks a reactivation campaign as converted (called externally when member pays).
 *
 * @param {number} campaignId
 * @returns {Promise<void>}
 */
async function markReactivationConverted(campaignId) {
  await prisma.reactivationCampaign.update({
    where: { id: campaignId },
    data: { status: 'converted', converted_at: new Date() },
  });
}

/**
 * Returns reactivation stats for a gym (admin view).
 * Queries run sequentially to respect the 5-connection pool limit.
 *
 * @param {number} gymId
 * @returns {Promise<object>}
 */
async function getReactivationStats(gymId) {
  const now = new Date();
  const churnMinDate = new Date(now - CHURN_MIN_DAYS * 24 * 60 * 60 * 1000);
  const churnMaxDate = new Date(now - CHURN_MAX_DAYS * 24 * 60 * 60 * 1000);

  const churnedMemberCount = await prisma.member.count({
    where: {
      gym_id: gymId,
      status: 'active',
      expiry_date: { lt: churnMinDate, gt: churnMaxDate },
      renewals: { none: { status: 'paid' } },
    },
  });

  const campaignBreakdown = await prisma.reactivationCampaign.groupBy({
    by: ['status'],
    where: { gym_id: gymId },
    _count: { id: true },
  });

  const revenueResult = await prisma.renewal.aggregate({
    where: {
      gym_id: gymId,
      status: 'paid',
      member: { reactivation_sent_at: { not: null } },
    },
    _sum: { amount: true },
    _count: { id: true },
  });

  const campaignCounts = {};
  for (const row of campaignBreakdown) campaignCounts[row.status] = row._count.id;

  const totalSent = (campaignCounts.sent || 0) + (campaignCounts.converted || 0) + (campaignCounts.expired || 0);
  const convertedCount = campaignCounts.converted || 0;
  const conversionRate = totalSent > 0 ? Math.round((convertedCount / totalSent) * 1000) / 1000 : 0;

  return {
    churned_member_count: churnedMemberCount,
    campaigns_sent: totalSent,
    campaigns_converted: convertedCount,
    campaigns_expired: campaignCounts.expired || 0,
    conversion_rate: conversionRate,
    reactivated_revenue: Math.round((revenueResult._sum.amount || 0) * 100) / 100,
  };
}

module.exports = {
  detectChurnedMembers,
  recordReactivationCampaign,
  markReactivationConverted,
  getReactivationStats,
};
