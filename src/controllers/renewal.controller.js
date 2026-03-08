'use strict';

const prisma = require('../lib/prisma');
const { sendSuccess, sendError } = require('../utils/response');

const VALID_STATUSES = [
  'pending', 'processing_link', 'link_generated', 'paid', 'failed', 'dead',
];

/**
 * GET /owner/renewals
 * Query: status?, limit?, offset?
 */
async function listRenewals(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const { status, limit = 50, offset = 0 } = req.query;

  if (status && !VALID_STATUSES.includes(status)) {
    return sendError(res, `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`, 400);
  }

  const where = { gym_id: gymId };
  if (status) where.status = status;

  try {
    const take = Math.min(parseInt(limit, 10) || 50, 200);
    const skip = parseInt(offset, 10) || 0;

    const [renewals, total] = await Promise.all([
      prisma.renewal.findMany({
        where,
        select: {
          id: true, status: true, amount: true, whatsapp_status: true,
          retry_count: true, created_at: true, updated_at: true,
          member: { select: { id: true, name: true, phone: true, plan_name: true } },
        },
        orderBy: { created_at: 'desc' },
        take,
        skip,
      }),
      prisma.renewal.count({ where }),
    ]);

    return sendSuccess(res, { renewals, total }, 'Renewals retrieved.');
  } catch (err) {
    next(err);
  }
}

module.exports = { listRenewals };
