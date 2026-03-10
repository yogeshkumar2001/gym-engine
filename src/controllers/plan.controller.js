'use strict';

const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { sendSuccess, sendError } = require('../utils/response');
const { createPlanSchema, updatePlanSchema } = require('../utils/validators/plan.validator');

/**
 * Enriches an array of plan objects with live member stats.
 * Uses two groupBy queries for active_members and total revenue.
 */
async function enrichPlansWithStats(gymId, plans) {
  const now = new Date();

  const [activeGroups, revenueGroups] = await Promise.all([
    prisma.member.groupBy({
      by: ['plan_name'],
      where: { gym_id: gymId, deleted_at: null, expiry_date: { gte: now } },
      _count: { id: true },
    }),
    prisma.member.groupBy({
      by: ['plan_name'],
      where: { gym_id: gymId, deleted_at: null },
      _sum: { plan_amount: true },
    }),
  ]);

  const activeMap  = Object.fromEntries(activeGroups.map((g) => [g.plan_name, g._count.id]));
  const revenueMap = Object.fromEntries(revenueGroups.map((g) => [g.plan_name, g._sum.plan_amount ?? 0]));

  return plans.map((p) => ({
    ...p,
    active_members:    activeMap[p.name]  ?? 0,
    revenue_generated: revenueMap[p.name] ?? 0,
  }));
}

/**
 * GET /owner/plans
 * Query: search?, status?, sort? (price|duration_days|revenue_generated|active_members)
 */
async function listPlans(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const { search, status, sort } = req.query;

  const where = { gym_id: gymId };
  if (status === 'active' || status === 'inactive') where.status = status;
  if (search) where.name = { contains: search };

  // DB-level sort for price and duration_days; app-level for computed fields
  const dbSortable = { price: true, duration_days: true };
  const orderBy = dbSortable[sort] ? { [sort]: 'asc' } : { created_at: 'asc' };

  try {
    let plans = await prisma.plan.findMany({ where, orderBy });
    plans = await enrichPlansWithStats(gymId, plans);

    // App-level sort for computed columns
    if (sort === 'revenue_generated') {
      plans.sort((a, b) => b.revenue_generated - a.revenue_generated);
    } else if (sort === 'active_members') {
      plans.sort((a, b) => b.active_members - a.active_members);
    }

    return sendSuccess(res, { plans, total: plans.length }, 'Plans retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /owner/plans/summary
 */
async function getPlanSummary(req, res, next) {
  const gymId = req.gymOwner.gym_id;

  try {
    const plans = await prisma.plan.findMany({ where: { gym_id: gymId } });
    const enriched = await enrichPlansWithStats(gymId, plans);

    const total        = enriched.length;
    const active       = enriched.filter((p) => p.status === 'active').length;
    const mostPopular  = enriched.reduce((best, p) => (p.active_members > (best?.active_members ?? -1) ? p : best), null);
    const highestRev   = enriched.reduce((best, p) => (p.revenue_generated > (best?.revenue_generated ?? -1) ? p : best), null);

    return sendSuccess(res, {
      total,
      active,
      most_popular:    mostPopular  ? { id: mostPopular.id,  name: mostPopular.name,  active_members: mostPopular.active_members }  : null,
      highest_revenue: highestRev   ? { id: highestRev.id,   name: highestRev.name,   revenue_generated: highestRev.revenue_generated } : null,
    }, 'Plan summary retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * POST /owner/plans
 */
async function createPlan(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const { error, value } = createPlanSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return sendError(res, 'Validation failed.', 400, error.details.map((d) => d.message));
  }

  try {
    const plan = await prisma.plan.create({
      data: { gym_id: gymId, ...value },
    });
    logger.info('[plan] Created', { gym_id: gymId, plan_id: plan.id });
    return sendSuccess(res, plan, 'Plan created.', 201);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /owner/plans/:planId
 */
async function updatePlan(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const planId = parseInt(req.params.planId, 10);

  if (!Number.isInteger(planId) || planId <= 0) {
    return sendError(res, 'Invalid planId.', 400);
  }

  const { error, value } = updatePlanSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return sendError(res, 'Validation failed.', 400, error.details.map((d) => d.message));
  }

  try {
    const existing = await prisma.plan.findUnique({ where: { id: planId } });
    if (!existing || existing.gym_id !== gymId) {
      return sendError(res, 'Plan not found.', 404);
    }

    const plan = await prisma.plan.update({ where: { id: planId }, data: value });
    logger.info('[plan] Updated', { gym_id: gymId, plan_id: planId });
    return sendSuccess(res, plan, 'Plan updated.');
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /owner/plans/:planId
 * If the plan has active members → mark inactive.
 * If no members use it → hard delete.
 */
async function deletePlan(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const planId = parseInt(req.params.planId, 10);

  if (!Number.isInteger(planId) || planId <= 0) {
    return sendError(res, 'Invalid planId.', 400);
  }

  try {
    const existing = await prisma.plan.findUnique({ where: { id: planId } });
    if (!existing || existing.gym_id !== gymId) {
      return sendError(res, 'Plan not found.', 404);
    }

    const usageCount = await prisma.member.count({
      where: { gym_id: gymId, plan_name: existing.name, deleted_at: null },
    });

    if (usageCount > 0) {
      await prisma.plan.update({ where: { id: planId }, data: { status: 'inactive' } });
      logger.info('[plan] Inactivated (has members)', { gym_id: gymId, plan_id: planId, member_count: usageCount });
      return sendSuccess(res, { inactivated: true }, `Plan has ${usageCount} member(s) — marked as inactive.`);
    }

    await prisma.plan.delete({ where: { id: planId } });
    logger.info('[plan] Deleted', { gym_id: gymId, plan_id: planId });
    return sendSuccess(res, null, 'Plan deleted.');
  } catch (err) {
    next(err);
  }
}

module.exports = { listPlans, getPlanSummary, createPlan, updatePlan, deletePlan };
