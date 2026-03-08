'use strict';

const prisma = require('../lib/prisma');
const { sendSuccess, sendError } = require('../utils/response');

const VALID_STATUSES = ['active', 'expired', 'inactive'];

/**
 * GET /owner/members
 * Query: status?, search?, limit?, offset?
 */
async function listMembers(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const { status, search, limit = 50, offset = 0 } = req.query;

  if (status && !VALID_STATUSES.includes(status)) {
    return sendError(res, `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`, 400);
  }

  const where = { gym_id: gymId };
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { name:  { contains: search } },
      { phone: { contains: search } },
    ];
  }

  try {
    const take = Math.min(parseInt(limit, 10) || 50, 200);
    const skip = parseInt(offset, 10) || 0;

    const [members, total] = await Promise.all([
      prisma.member.findMany({
        where,
        select: {
          id: true, name: true, phone: true, plan_name: true,
          plan_amount: true, status: true, expiry_date: true, join_date: true,
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

    if (!member || member.gym_id !== gymId) {
      return sendError(res, 'Member not found.', 404);
    }

    return sendSuccess(res, member, 'Member retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /owner/members/at-risk
 * Returns active members whose expiry_date falls within the next 7 days.
 */
async function getAtRiskMembers(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  try {
    const members = await prisma.member.findMany({
      where: {
        gym_id: gymId,
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

module.exports = { listMembers, getMember, getAtRiskMembers };
