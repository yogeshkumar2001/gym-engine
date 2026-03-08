'use strict';

const fs = require('fs');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { settleRenewal } = require('../services/renewalService');
const { decryptGymCredentials } = require('../utils/encryption');
const { generateInvoicePDF } = require('../services/invoiceService');
const { sendPaymentConfirmation } = require('../services/whatsappService');

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
            id:         true,
            name:       true,
            phone:      true,
            plan_name:  true,
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

    // 10. Already paid → idempotent
    if (renewal.status === 'paid') {
      logger.info(`[webhook] Renewal already settled — renewal_id=${renewal.id}`);
      return res.status(200).json({ success: true, message: 'Already processed.' });
    }

    // 11. Compute new expiry (mirrors settleRenewal logic)
    const days = (Number.isInteger(renewal.plan_duration_days) && renewal.plan_duration_days > 0)
      ? renewal.plan_duration_days
      : 30;
    const newExpiry = new Date(renewal.member.expiry_date);
    newExpiry.setUTCDate(newExpiry.getUTCDate() + days);

    // 12. Settle: mark renewal paid + extend member expiry
    await settleRenewal(
      renewal.id,
      renewal.member.id,
      renewal.member.expiry_date,
      renewal.plan_duration_days,
    );

    logger.info('[webhook] Renewal settled', {
      gym_id:             gymId,
      renewal_id:         renewal.id,
      member_id:          renewal.member.id,
      payment_link_id:    paymentLinkId,
      plan_duration_days: renewal.plan_duration_days,
      new_expiry:         newExpiry.toISOString(),
    });

    // 13. Post-settlement: generate invoice + send WhatsApp confirmation.
    //     Wrapped in try/catch — failures must NOT block the 200 response to Razorpay.
    let invoicePath = null;
    try {
      invoicePath = await generateInvoicePDF(gym, renewal.member, renewal, newExpiry);
      await sendPaymentConfirmation(gym, renewal.member, renewal, newExpiry, invoicePath);
      logger.info('[webhook] Invoice and confirmation sent', {
        gym_id: gymId,
        renewal_id: renewal.id,
      });
    } catch (postErr) {
      logger.error('[webhook] Post-settlement notification failed (payment still settled)', {
        gym_id:     gymId,
        renewal_id: renewal.id,
        message:    postErr.message,
        api_error:  postErr.response?.data ?? null,
      });
    } finally {
      // Clean up temp PDF regardless of send outcome
      if (invoicePath) {
        fs.unlink(invoicePath, (unlinkErr) => {
          if (unlinkErr) {
            logger.warn(`[webhook] Could not delete invoice file: ${invoicePath}`);
          }
        });
      }
    }

    return res.status(200).json({ success: true, message: 'Payment settled.' });
  } catch (err) {
    logger.error('[webhook] Unexpected error', { message: err.message, stack: err.stack });
    next(err);
  }
}

module.exports = { handleRazorpayWebhook };
