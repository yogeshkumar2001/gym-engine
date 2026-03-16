'use strict';

const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { sendSuccess, sendError } = require('../utils/response');
const { markPaidSchema } = require('../utils/validators/manualPayment.validator');
const { handleSuccessfulPayment } = require('../services/renewalService');
const { decryptGymCredentials } = require('../utils/encryption');

/**
 * POST /owner/members/:memberId/mark-paid
 *
 * Records a manual cash or UPI payment for a member, settles the renewal,
 * generates an invoice (if the invoice service is enabled), and sends a
 * WhatsApp payment confirmation.
 *
 * Body:
 *   { "payment_method": "cash" | "upi", "amount": number }
 */
async function markMemberPaid(req, res, next) {
  try {
    const gymId    = req.gymOwner.gym_id;
    const memberId = parseInt(req.params.memberId, 10);

    if (!Number.isInteger(memberId) || memberId <= 0) {
      return sendError(res, 'Invalid memberId.', 400);
    }

    const { error, value } = markPaidSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return sendError(res, 'Validation failed.', 400, error.details.map((d) => d.message));
    }

    const { payment_method, amount } = value;

    // 1. Fetch member — verify it belongs to this gym and is not deleted
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: {
        id:                true,
        gym_id:            true,
        name:              true,
        phone:             true,
        plan_name:         true,
        plan_duration_days: true,
        expiry_date:       true,
        deleted_at:        true,
      },
    });

    if (!member || member.gym_id !== gymId || member.deleted_at !== null) {
      return sendError(res, 'Member not found.', 404);
    }

    // 2. Fetch gym with WhatsApp credentials + service flags
    const gym = await prisma.gym.findUnique({
      where: { id: gymId },
      select: {
        id:                       true,
        name:                     true,
        whatsapp_phone_number_id: true,
        whatsapp_access_token:    true,
        services:                 true,
      },
    });

    decryptGymCredentials(gym);

    // 3. Create a new renewal record for this payment
    const renewal = await prisma.renewal.create({
      data: {
        gym_id:            gymId,
        member_id:         memberId,
        amount,
        plan_duration_days: member.plan_duration_days,
        status:            'pending',
      },
    });

    logger.info('[manualPayment] Renewal created for manual payment', {
      gym_id: gymId, member_id: memberId, renewal_id: renewal.id, payment_method, amount,
    });

    // 4. Settle, generate invoice, send WhatsApp confirmation
    const { newExpiry } = await handleSuccessfulPayment(gym, member, renewal, payment_method);

    logger.info('[manualPayment] Payment recorded', {
      gym_id: gymId, member_id: memberId, renewal_id: renewal.id,
      payment_method, new_expiry: newExpiry.toISOString(),
    });

    return sendSuccess(
      res,
      { renewal_id: renewal.id, new_expiry: newExpiry },
      'Payment recorded successfully.',
      201
    );
  } catch (err) {
    logger.error('[manualPayment] Unexpected error', { message: err.message, stack: err.stack });
    next(err);
  }
}

module.exports = { markMemberPaid };
