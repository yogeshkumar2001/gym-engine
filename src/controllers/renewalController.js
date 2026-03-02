'use strict';

const prisma = require('../lib/prisma');
const { createRenewalPaymentLink } = require('../services/razorpayService');
const { sendSuccess, sendError } = require('../utils/response');
const logger = require('../config/logger');

const triggerRenewal = async (req, res, next) => {
  try {
    const gymId = parseInt(req.params.gymId, 10);
    const memberId = parseInt(req.params.memberId, 10);

    if (isNaN(gymId) || gymId <= 0 || isNaN(memberId) || memberId <= 0) {
      return sendError(res, 'Invalid gymId or memberId.', 400);
    }

    logger.info(`[renewalController] Trigger renewal: gym=${gymId}, member=${memberId}`);

    const [gym, member] = await Promise.all([
      prisma.gym.findUnique({ where: { id: gymId } }),
      prisma.member.findUnique({ where: { id: memberId } }),
    ]);

    if (!gym) {
      return sendError(res, 'Gym not found.', 404);
    }
    if (!member) {
      return sendError(res, 'Member not found.', 404);
    }
    if (member.gym_id !== gymId) {
      return sendError(res, 'Member does not belong to this gym.', 403);
    }

    const result = await createRenewalPaymentLink(gym, member);

    logger.info(
      `[renewalController] Renewal triggered for member ${memberId}: linkId=${result.paymentLinkId}`
    );

    return sendSuccess(res, result, 'Payment link created successfully.');
  } catch (err) {
    logger.error(`[renewalController] Error: ${err.message}`, { stack: err.stack });

    // Razorpay API errors carry a response body in err.error
    if (err.error) {
      const rp = err.error;
      logger.error(`[renewalController] Razorpay error: ${JSON.stringify(rp)}`);
      return sendError(
        res,
        rp.description || 'Razorpay error. Check credentials and account status.',
        502
      );
    }

    next(err);
  }
};

module.exports = { triggerRenewal };
