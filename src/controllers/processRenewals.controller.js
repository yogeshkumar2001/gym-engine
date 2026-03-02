'use strict';

const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { sendSuccess, sendError } = require('../utils/response');
const { createPaymentLinkForRenewal } = require('../services/razorpayService');
const { markLinkGenerated } = require('../services/renewalService');

async function processRenewals(req, res, next) {
  try {
    // 1. Validate gymId
    const gymId = parseInt(req.params.gymId, 10);
    if (!Number.isInteger(gymId) || gymId <= 0) {
      return sendError(res, 'gymId must be a positive integer.', 400);
    }

    // 2. Fetch gym — only the fields we need (avoid exposing full record)
    const gym = await prisma.gym.findUnique({
      where: { id: gymId },
      select: {
        id: true,
        name: true,
        razorpay_key_id: true,
        razorpay_key_secret: true,
      },
    });

    if (!gym) {
      return sendError(res, 'Gym not found.', 404);
    }

    // 3. Fetch all pending renewals for this gym, with member contact info
    const renewals = await prisma.renewal.findMany({
      where: { gym_id: gymId, status: 'pending' },
      include: {
        member: {
          select: { id: true, name: true, phone: true },
        },
      },
    });

    if (renewals.length === 0) {
      logger.info(`[processRenewals] gym_id=${gymId}: no pending renewals.`);
      return sendSuccess(res, { processed: 0, success: 0, failed: 0 }, 'No pending renewals.');
    }

    logger.info(
      `[processRenewals] gym_id=${gymId} "${gym.name}": processing ${renewals.length} pending renewal(s).`
    );

    let success = 0;
    let failed = 0;

    // 4. Process each renewal independently — one failure must not stop others
    for (const renewal of renewals) {
      try {
        const { paymentLinkId, shortUrl } = await createPaymentLinkForRenewal(
          gym,
          renewal,
          renewal.member
        );

        await markLinkGenerated(renewal.id, paymentLinkId, shortUrl);

        success++;
        logger.info('[processRenewals] Payment link generated', {
          gym_id: gymId,
          renewal_id: renewal.id,
          member_id: renewal.member.id,
          short_url: shortUrl,
        });
      } catch (err) {
        failed++;
        logger.error('[processRenewals] Failed to process renewal', {
          gym_id: gymId,
          renewal_id: renewal.id,
          member_id: renewal.member.id,
          message: err.message,
          razorpay_error: err.error ?? null,
        });
      }
    }

    logger.info(
      `[processRenewals] gym_id=${gymId} complete. ` +
      `processed=${renewals.length}, success=${success}, failed=${failed}`
    );

    // 5. Return summary
    return sendSuccess(
      res,
      { processed: renewals.length, success, failed },
      'Renewals processed.'
    );
  } catch (err) {
    logger.error('[processRenewals] Unexpected error', { message: err.message, stack: err.stack });
    next(err);
  }
}

module.exports = { processRenewals };
