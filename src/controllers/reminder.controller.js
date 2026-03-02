'use strict';

const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { sendSuccess, sendError } = require('../utils/response');
const { getTargetDayWindow, getFortyEightHoursAgo } = require('../utils/dateUtils');

async function triggerReminder(req, res, next) {
  try {
    // 1. Validate gymId and memberId — must be positive integers
    const gymId = parseInt(req.params.gymId, 10);
    const memberId = parseInt(req.params.memberId, 10);

    if (!Number.isInteger(gymId) || gymId <= 0 || !Number.isInteger(memberId) || memberId <= 0) {
      return sendError(res, 'gymId and memberId must be positive integers.', 400);
    }

    // 2. Confirm gym exists
    const gym = await prisma.gym.findUnique({ where: { id: gymId } });
    if (!gym) {
      return sendError(res, 'Gym not found.', 404);
    }

    // 3. Confirm member exists and belongs to this gym
    const member = await prisma.member.findFirst({
      where: { id: memberId, gym_id: gymId },
    });
    if (!member) {
      return sendError(res, 'Member not found.', 404);
    }

    // 4. Re-check eligibility
    const { startOfTargetDay, endOfTargetDay } = getTargetDayWindow(3);
    const fortyEightHoursAgo = getFortyEightHoursAgo();

    const isActive = member.status === 'active';
    const isExpiringOnTargetDay =
      member.expiry_date >= startOfTargetDay && member.expiry_date <= endOfTargetDay;
    const isReminderDue =
      member.last_reminder_sent_at === null ||
      member.last_reminder_sent_at <= fortyEightHoursAgo;

    logger.debug('Reminder eligibility check', {
      memberId,
      gymId,
      status: member.status,
      expiry_date: member.expiry_date.toISOString(),
      last_reminder_sent_at: member.last_reminder_sent_at?.toISOString() ?? null,
      startOfTargetDay: startOfTargetDay.toISOString(),
      endOfTargetDay: endOfTargetDay.toISOString(),
      fortyEightHoursAgo: fortyEightHoursAgo.toISOString(),
      isActive,
      isExpiringOnTargetDay,
      isReminderDue,
    });

    // 5. Reject if not eligible
    if (!isActive || !isExpiringOnTargetDay || !isReminderDue) {
      logger.info('Member not eligible for reminder', { memberId, gymId });
      return sendError(res, 'Member not eligible for reminder.', 400);
    }

    // 6. Mark reminder as sent
    const now = new Date();
    await prisma.member.update({
      where: { id: memberId },
      data: { last_reminder_sent_at: now },
    });

    logger.info('Reminder triggered successfully', { memberId, gymId, updatedAt: now.toISOString() });

    return sendSuccess(
      res,
      { memberId, updatedAt: now.toISOString() },
      'Reminder triggered.'
    );
  } catch (err) {
    logger.error('triggerReminder error', { message: err.message, stack: err.stack });
    next(err);
  }
}

module.exports = { triggerReminder };
