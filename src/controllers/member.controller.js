'use strict';

const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { sendSuccess, sendError } = require('../utils/response');
const { createMemberSchema, updateMemberSchema, updateProfileSchema } = require('../utils/validators/member.validator');

function computeExpiry(joinDate, durationDays) {
  const d = new Date(joinDate);
  d.setDate(d.getDate() + durationDays);
  return d;
}

/**
 * GET /owner/members
 * Query: filter? (all|active|expired|expiring_soon), search?, limit?, offset?
 */
async function listMembers(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const { filter, search, limit = 50, offset = 0 } = req.query;
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const where = { gym_id: gymId, deleted_at: null };

  if (filter === 'active') {
    where.expiry_date = { gte: now };
  } else if (filter === 'expired') {
    where.expiry_date = { lt: now };
  } else if (filter === 'expiring_soon') {
    where.expiry_date = { gte: now, lte: in7Days };
  }

  if (search) {
    where.OR = [
      { name:  { contains: search } },
      { phone: { contains: search } },
    ];
  }

  try {
    const take = Math.min(parseInt(limit, 10) || 50, 500);
    const skip = parseInt(offset, 10) || 0;

    const [members, total] = await Promise.all([
      prisma.member.findMany({
        where,
        select: {
          id: true, name: true, phone: true, plan_name: true,
          plan_amount: true, plan_duration_days: true,
          join_date: true, expiry_date: true, status: true,
        },
        orderBy: { expiry_date: 'asc' },
        take,
        skip,
      }),
      prisma.member.count({ where }),
    ]);

    return sendSuccess(res, { members, total }, 'Members retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /owner/members/summary
 */
async function getMemberSummary(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  try {
    const [total, active, expiringSoon, expired] = await Promise.all([
      prisma.member.count({ where: { gym_id: gymId, deleted_at: null } }),
      prisma.member.count({ where: { gym_id: gymId, deleted_at: null, expiry_date: { gte: now } } }),
      prisma.member.count({ where: { gym_id: gymId, deleted_at: null, expiry_date: { gte: now, lte: in7Days } } }),
      prisma.member.count({ where: { gym_id: gymId, deleted_at: null, expiry_date: { lt: now } } }),
    ]);

    return sendSuccess(res, {
      total,
      active,
      expiring_soon: expiringSoon,
      expired,
    }, 'Summary retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /owner/members/at-risk
 */
async function getAtRiskMembers(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  try {
    const members = await prisma.member.findMany({
      where: {
        gym_id: gymId,
        deleted_at: null,
        status: 'active',
        expiry_date: { lte: in7Days },
      },
      select: {
        id: true, name: true, phone: true,
        plan_name: true, plan_amount: true, expiry_date: true,
      },
      orderBy: { expiry_date: 'asc' },
      take: 100,
    });

    return sendSuccess(res, { members }, 'At-risk members retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /owner/members/:memberId
 */
async function getMember(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const memberId = parseInt(req.params.memberId, 10);

  if (!Number.isInteger(memberId) || memberId <= 0) {
    return sendError(res, 'Invalid memberId.', 400);
  }

  try {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      include: { renewals: { orderBy: { created_at: 'desc' }, take: 10 } },
    });

    if (!member || member.gym_id !== gymId || member.deleted_at !== null) {
      return sendError(res, 'Member not found.', 404);
    }

    return sendSuccess(res, member, 'Member retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * POST /owner/members
 */
async function createMember(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const { error, value } = createMemberSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return sendError(res, 'Validation failed.', 400, error.details.map((d) => d.message));
  }

  const { name, phone, plan_name, plan_amount, plan_duration_days, join_date } = value;
  const joinDate = new Date(join_date);
  const expiryDate = computeExpiry(joinDate, plan_duration_days);
  const now = new Date();

  try {
    // Tier limit enforcement: count existing non-deleted members against member_limit
    const gym = await prisma.gym.findUnique({
      where: { id: gymId },
      select: { member_limit: true, subscription_tier: true },
    });
    if (gym) {
      const currentCount = await prisma.member.count({
        where: { gym_id: gymId, deleted_at: null },
      });
      if (currentCount >= gym.member_limit) {
        return sendError(
          res,
          `Member limit reached for your ${gym.subscription_tier} plan (${gym.member_limit} members). Please upgrade to add more members.`,
          402
        );
      }
    }

    const member = await prisma.member.create({
      data: {
        gym_id: gymId,
        name,
        phone,
        plan_name,
        plan_amount,
        plan_duration_days,
        join_date: joinDate,
        expiry_date: expiryDate,
        status: expiryDate >= now ? 'active' : 'expired',
      },
    });
    logger.info('[member] Created', { gym_id: gymId, member_id: member.id });
    return sendSuccess(res, member, 'Member created.', 201);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /owner/members/:memberId
 */
async function updateMember(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const memberId = parseInt(req.params.memberId, 10);

  if (!Number.isInteger(memberId) || memberId <= 0) {
    return sendError(res, 'Invalid memberId.', 400);
  }

  const { error, value } = updateMemberSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return sendError(res, 'Validation failed.', 400, error.details.map((d) => d.message));
  }

  try {
    const existing = await prisma.member.findUnique({ where: { id: memberId } });
    if (!existing || existing.gym_id !== gymId || existing.deleted_at !== null) {
      return sendError(res, 'Member not found.', 404);
    }

    const joinDate = value.join_date ? new Date(value.join_date) : new Date(existing.join_date);
    const durationDays = value.plan_duration_days ?? existing.plan_duration_days;
    const expiryDate = computeExpiry(joinDate, durationDays);
    const now = new Date();

    const member = await prisma.member.update({
      where: { id: memberId },
      data: {
        ...value,
        join_date: joinDate,
        expiry_date: expiryDate,
        status: expiryDate >= now ? 'active' : 'expired',
      },
    });

    logger.info('[member] Updated', { gym_id: gymId, member_id: memberId });
    return sendSuccess(res, member, 'Member updated.');
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /owner/members/:memberId
 * Soft delete — sets deleted_at timestamp.
 */
async function deleteMember(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const memberId = parseInt(req.params.memberId, 10);

  if (!Number.isInteger(memberId) || memberId <= 0) {
    return sendError(res, 'Invalid memberId.', 400);
  }

  try {
    const existing = await prisma.member.findUnique({ where: { id: memberId } });
    if (!existing || existing.gym_id !== gymId || existing.deleted_at !== null) {
      return sendError(res, 'Member not found.', 404);
    }

    await prisma.member.update({
      where: { id: memberId },
      data: { deleted_at: new Date() },
    });

    logger.info('[member] Soft-deleted', { gym_id: gymId, member_id: memberId });
    return sendSuccess(res, null, 'Member deleted.');
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /owner/members/:memberId/profile
 * Updates optional profile and identity verification fields only.
 */
async function updateMemberProfile(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const memberId = parseInt(req.params.memberId, 10);

  if (!Number.isInteger(memberId) || memberId <= 0) {
    return sendError(res, 'Invalid memberId.', 400);
  }

  const { error, value } = updateProfileSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return sendError(res, 'Validation failed.', 400, error.details.map((d) => d.message));
  }

  try {
    const existing = await prisma.member.findUnique({ where: { id: memberId } });
    if (!existing || existing.gym_id !== gymId || existing.deleted_at !== null) {
      return sendError(res, 'Member not found.', 404);
    }

    const member = await prisma.member.update({
      where: { id: memberId },
      data: value,
      select: {
        id: true, name: true, phone: true,
        photo_url: true, id_proof_type: true, id_proof_number: true, id_proof_url: true,
      },
    });

    logger.info('[member] Profile updated', { gym_id: gymId, member_id: memberId });
    return sendSuccess(res, member, 'Profile updated.');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listMembers,
  getMemberSummary,
  getAtRiskMembers,
  getMember,
  createMember,
  updateMember,
  updateMemberProfile,
  deleteMember,
};
