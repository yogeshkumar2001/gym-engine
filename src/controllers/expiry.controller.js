'use strict';

const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { sendSuccess, sendError } = require('../utils/response');
const { getTargetDayWindow, getFortyEightHoursAgo } = require('../utils/dateUtils');

async function testExpiry(req, res, next) {
  try {
    // 1. Validate gymId — must be a positive integer
    const gymId = parseInt(req.params.gymId, 10);
    if (!Number.isInteger(gymId) || gymId <= 0) {
      return sendError(res, 'gymId must be a positive integer.', 400);
    }

    // 2. Fetch gym — 404 if not found
    const gym = await prisma.gym.findUnique({ where: { id: gymId } });
    if (!gym) {
      return sendError(res, 'Gym not found.', 404);
    }

    // 3 & 4. UTC day boundaries for today + 3 days
    const { startOfTargetDay, endOfTargetDay } = getTargetDayWindow(3);
    const fortyEightHoursAgo = getFortyEightHoursAgo();

    logger.debug('Expiry detection window', {
      gymId,
      startOfTargetDay: startOfTargetDay.toISOString(),
      endOfTargetDay: endOfTargetDay.toISOString(),
      fortyEightHoursAgo: fortyEightHoursAgo.toISOString(),
    });

    // 5. Query members due for a reminder
    const members = await prisma.member.findMany({
      where: {
        gym_id: gymId,
        status: 'active',
        expiry_date: {
          gte: startOfTargetDay,
          lte: endOfTargetDay,
        },
        OR: [
          { last_reminder_sent_at: null },
          { last_reminder_sent_at: { lte: fortyEightHoursAgo } },
        ],
      },
      select: {
        id: true,
        name: true,
        phone: true,
        expiry_date: true,
      },
    });

    logger.info('Expiry detection completed', { gymId, eligible: members.length });

    // 6. Return result — does NOT update last_reminder_sent_at
    return sendSuccess(res, { count: members.length, members }, 'Expiry detection completed.');
  } catch (err) {
    logger.error('testExpiry error', { message: err.message, stack: err.stack });
    next(err);
  }
}

module.exports = { testExpiry };
