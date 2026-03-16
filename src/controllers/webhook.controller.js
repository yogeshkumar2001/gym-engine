'use strict';

const crypto = require('crypto');
const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { handleSuccessfulPayment } = require('../services/renewalService');
const { decryptGymCredentials } = require('../utils/encryption');

async function handleRazorpayWebhook(req, res, next) {
  try {
    // 1. Validate gymId
    const gymId = parseInt(req.params.gymId, 10);
    if (!Number.isInteger(gymId) || gymId <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid gymId.' });
    }

    // 2. Fetch gym — webhook secret for HMAC + WhatsApp creds for post-settlement
    const gym = await prisma.gym.findUnique({
      where: { id: gymId },
      select: {
        id:                       true,
        name:                     true,
        razorpay_webhook_secret:  true,
        whatsapp_phone_number_id: true,
        whatsapp_access_token:    true,
        services:                 true,
      },
    });

    if (!gym) {
      return res.status(400).json({ success: false, message: 'Gym not found.' });
    }

    decryptGymCredentials(gym);

    // 3. Verify Razorpay signature using raw body
    const signature = req.headers['x-razorpay-signature'];
    if (!signature) {
      logger.warn(`[webhook] Missing signature header for gym_id=${gymId}`);
      return res.status(400).json({ success: false, message: 'Missing signature.' });
    }

    const expectedSig = crypto
      .createHmac('sha256', gym.razorpay_webhook_secret)
      .update(req.body) // req.body is a raw Buffer via express.raw()
      .digest('hex');

    let isValid = false;
    try {
      const expectedBuf = Buffer.from(expectedSig, 'hex');
      const sigBuf = Buffer.from(signature, 'hex');
      isValid =
        expectedBuf.length === sigBuf.length &&
        crypto.timingSafeEqual(expectedBuf, sigBuf);
    } catch {
      isValid = false;
    }

    // 4. Reject invalid signatures
    if (!isValid) {
      logger.warn(`[webhook] Invalid signature for gym_id=${gymId}`);
      return res.status(400).json({ success: false, message: 'Invalid signature.' });
    }

    // 5. Parse event from raw buffer
    let event;
    try {
      event = JSON.parse(req.body.toString());
    } catch {
      logger.warn(`[webhook] Malformed JSON body for gym_id=${gymId}`);
      return res.status(400).json({ success: false, message: 'Malformed request body.' });
    }

    logger.info(`[webhook] gym_id=${gymId}, event="${event.event}"`);

    // 6. Only handle payment_link.paid — silently acknowledge everything else
    if (event.event !== 'payment_link.paid') {
      return res.status(200).json({ success: true, message: 'Event ignored.' });
    }

    // 7. Extract payment_link_id from payload
    const paymentLinkId = event.payload?.payment_link?.entity?.id;
    if (!paymentLinkId) {
      logger.warn('[webhook] payment_link.paid missing payload.payment_link.entity.id');
      return res.status(200).json({ success: true, message: 'Event ignored.' });
    }

    // 8. Find renewal by payment link ID scoped to this gym
    const renewal = await prisma.renewal.findFirst({
      where: {
        razorpay_payment_link_id: paymentLinkId,
        gym_id: gymId,
      },
      select: {
        id:                       true,
        status:                   true,
        amount:                   true,
        plan_duration_days:       true,
        razorpay_payment_link_id: true,
        member: {
          select: {
            id:          true,
            name:        true,
            phone:       true,
            plan_name:   true,
            expiry_date: true,
          },
        },
      },
    });

    // 9. Not found → acknowledge and move on
    if (!renewal) {
      logger.warn(`[webhook] No renewal found for payment_link_id=${paymentLinkId}`);
      return res.status(200).json({ success: true, message: 'Renewal not found, ignored.' });
    }

    // 10. Settle + notify via unified handler (handles idempotency internally)
    const { alreadyPaid, newExpiry } = await handleSuccessfulPayment(
      gym, renewal.member, renewal, 'razorpay'
    );

    if (alreadyPaid) {
      return res.status(200).json({ success: true, message: 'Already processed.' });
    }

    logger.info('[webhook] Renewal settled', {
      gym_id:             gymId,
      renewal_id:         renewal.id,
      member_id:          renewal.member.id,
      payment_link_id:    paymentLinkId,
      plan_duration_days: renewal.plan_duration_days,
      new_expiry:         newExpiry.toISOString(),
    });

    return res.status(200).json({ success: true, message: 'Payment settled.' });
  } catch (err) {
    logger.error('[webhook] Unexpected error', { message: err.message, stack: err.stack });
    next(err);
  }
}

module.exports = { handleRazorpayWebhook };
