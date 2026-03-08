'use strict';

const prisma = require('../lib/prisma');

/**
 * getMemberLTV(memberId)
 * Total lifetime value for a single member based on captured payments.
 */
async function getMemberLTV(memberId) {
  const result = await prisma.payment.aggregate({
    where: {
      member_id: memberId,
      status: 'captured',
    },
    _sum: { amount: true },
    _count: { id: true },
  });

  return {
    member_id: memberId,
    total_paid: result._sum.amount || 0,
    payment_count: result._count.id,
  };
}

/**
 * getGymLTVReport(gymId)
 *
 * Returns per-member LTV with retention data, plus gym-level summary:
 *   total_members
 *   members_with_payments
 *   total_lifetime_revenue
 *   avg_member_ltv         — average across members who have paid at least once
 *   avg_retention_months   — average across all members (join_date → expiry_date)
 *   members[]              — individual breakdown
 */
async function getGymLTVReport(gymId) {
  // Sequential to stay within pool limit of 5
  const members = await prisma.member.findMany({
    where: { gym_id: gymId },
    select: {
      id: true,
      name: true,
      phone: true,
      plan_name: true,
      join_date: true,
      expiry_date: true,
      status: true,
    },
    orderBy: { id: 'asc' },
  });

  const paymentGroups = await prisma.payment.groupBy({
    by: ['member_id'],
    where: {
      gym_id: gymId,
      status: 'captured',
    },
    _sum: { amount: true },
    _count: { id: true },
  });

  const paymentMap = {};
  for (const p of paymentGroups) {
    paymentMap[p.member_id] = {
      total_paid: p._sum.amount || 0,
      payment_count: p._count.id,
    };
  }

  const now = new Date();
  const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30;

  const memberRows = members.map((m) => {
    const paid = paymentMap[m.id] || { total_paid: 0, payment_count: 0 };
    const endDate = m.expiry_date || now;
    const retentionMonths =
      Math.round((Math.max(0, endDate.getTime() - m.join_date.getTime()) / MS_PER_MONTH) * 10) / 10;

    return {
      member_id: m.id,
      name: m.name,
      phone: m.phone,
      plan_name: m.plan_name,
      status: m.status,
      total_paid: Math.round(paid.total_paid * 100) / 100,
      payment_count: paid.payment_count,
      retention_months: retentionMonths,
    };
  });

  const totalRevenue = memberRows.reduce((s, m) => s + m.total_paid, 0);
  const payingMembers = memberRows.filter((m) => m.total_paid > 0);
  const avgLTV =
    payingMembers.length > 0
      ? Math.round((totalRevenue / payingMembers.length) * 100) / 100
      : 0;
  const avgRetention =
    memberRows.length > 0
      ? Math.round(
          (memberRows.reduce((s, m) => s + m.retention_months, 0) / memberRows.length) * 10,
        ) / 10
      : 0;

  return {
    gym_id: gymId,
    total_members: members.length,
    members_with_payments: payingMembers.length,
    total_lifetime_revenue: Math.round(totalRevenue * 100) / 100,
    avg_member_ltv: avgLTV,
    avg_retention_months: avgRetention,
    members: memberRows,
  };
}

/**
 * getPlanProfitability(gymId)
 *
 * Groups all members by plan_name and returns:
 *   member_count
 *   avg_plan_amount
 *   avg_ltv              — average captured payments per member on this plan
 *   avg_retention_months
 *   total_revenue
 *
 * Sorted by total_revenue descending so the best-performing plan is first.
 */
async function getPlanProfitability(gymId) {
  // Sequential to stay within pool limit of 5
  const members = await prisma.member.findMany({
    where: { gym_id: gymId },
    select: {
      id: true,
      plan_name: true,
      plan_amount: true,
      join_date: true,
      expiry_date: true,
    },
  });

  const paymentGroups = await prisma.payment.groupBy({
    by: ['member_id'],
    where: {
      gym_id: gymId,
      status: 'captured',
    },
    _sum: { amount: true },
  });

  const paymentMap = {};
  for (const p of paymentGroups) {
    paymentMap[p.member_id] = p._sum.amount || 0;
  }

  const now = new Date();
  const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30;

  // Accumulate per-plan totals
  const planMap = {};
  for (const m of members) {
    if (!planMap[m.plan_name]) {
      planMap[m.plan_name] = {
        plan_name: m.plan_name,
        member_count: 0,
        total_paid: 0,
        total_plan_amount: 0,
        total_retention_months: 0,
      };
    }
    const entry = planMap[m.plan_name];
    entry.member_count++;
    entry.total_paid += paymentMap[m.id] || 0;
    entry.total_plan_amount += m.plan_amount;
    const endDate = m.expiry_date || now;
    entry.total_retention_months +=
      Math.max(0, endDate.getTime() - m.join_date.getTime()) / MS_PER_MONTH;
  }

  const plans = Object.values(planMap)
    .map((p) => ({
      plan_name: p.plan_name,
      member_count: p.member_count,
      avg_plan_amount: Math.round((p.total_plan_amount / p.member_count) * 100) / 100,
      avg_ltv: Math.round((p.total_paid / p.member_count) * 100) / 100,
      avg_retention_months: Math.round((p.total_retention_months / p.member_count) * 10) / 10,
      total_revenue: Math.round(p.total_paid * 100) / 100,
    }))
    .sort((a, b) => b.total_revenue - a.total_revenue);

  return {
    gym_id: gymId,
    plan_count: plans.length,
    plans,
  };
}

module.exports = { getMemberLTV, getGymLTVReport, getPlanProfitability };
