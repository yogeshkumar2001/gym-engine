'use strict';

const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { sendSuccess, sendError } = require('../utils/response');
const { sendRenewalReminder } = require('../services/whatsappService');
const { acquireWhatsappLock, releaseWhatsappLock } = require('../services/renewalService');
const { decryptGymCredentials } = require('../utils/encryption');

/**
 * POST /send-renewals/:gymId
 *
 * Dispatches WhatsApp renewal reminders for all link_generated renewals
 * that have not yet been notified (whatsapp_sent_at IS NULL).
 *
 * Rules:
 *  - Only processes renewals with status = "link_generated"
 *  - Skips renewals where whatsapp_sent_at is already set (sent-once guarantee)
 *  - On success: records whatsapp_message_id, whatsapp_sent_at, whatsapp_status = "sent"
 *  - On failure: records whatsapp_status = "failed", leaves whatsapp_sent_at NULL
 *    so the renewal is retried on the next invocation
 *  - A single renewal failure does not abort the rest of the batch
 */
async function sendRenewals(req, res, next) {
  try {
    // 1. Validate gymId
    const gymId = parseInt(req.params.gymId, 10);
    if (!Number.isInteger(gymId) || gymId <= 0) {
      return sendError(res, 'gymId must be a positive integer.', 400);
    }

    // 2. Fetch gym — only the fields needed for WhatsApp
    const gym = await prisma.gym.findUnique({
      where: { id: gymId },
      select: {
        id: true,
        name: true,
        whatsapp_phone_number_id: true,
        whatsapp_access_token: true,
      },
    });

    if (!gym) {
      return sendError(res, 'Gym not found.', 404);
    }

    // Decrypt AES-256-GCM credentials before passing to Meta Cloud API.
    decryptGymCredentials(gym);

    // 3. Fetch eligible renewals: link_generated AND not yet sent
    const renewals = await prisma.renewal.findMany({
      where: {
        gym_id: gymId,
        status: 'link_generated',
        whatsapp_sent_at: null,
      },
      include: {
        member: {
          select: { id: true, name: true, phone: true },
        },
      },
    });

    if (renewals.length === 0) {
      logger.info(`[sendRenewals] gym_id=${gymId}: no eligible renewals to notify.`);
      return sendSuccess(
        res,
        { processed: 0, success: 0, skipped: 0, failed: 0 },
        'No eligible renewals to notify.'
      );
    }

    logger.info(
      `[sendRenewals] gym_id=${gymId} "${gym.name}": sending reminders for ${renewals.length} renewal(s).`
    );

    let success = 0;
    let skipped = 0;
    let failed = 0;

    // 4. Process each renewal independently — one failure must not stop others
    for (const renewal of renewals) {
      try {
        const now = new Date();

        // Atomic lock: transition to whatsapp_status='sending' only if
        // whatsapp_sent_at is still null. Exactly one concurrent caller wins.
        const lock = await acquireWhatsappLock(renewal.id, now);

        if (lock === false) {
          // Another process claimed this renewal between our findMany and now.
          skipped++;
          logger.info('[sendRenewals] Skipping — WhatsApp lock already acquired by another process', {
            gym_id: gymId,
            renewal_id: renewal.id,
          });
          continue;
        }

        // This process owns the send slot — call the Meta API.
        try {
          const { messageId } = await sendRenewalReminder(gym, renewal, renewal.member);
          await prisma.renewal.update({
            where: { id: renewal.id },
            data: {
              whatsapp_message_id: messageId,
              whatsapp_status: 'sent',
            },
          });
          success++;
          logger.info('[sendRenewals] Reminder sent and recorded', {
            gym_id: gymId,
            renewal_id: renewal.id,
            member_id: renewal.member.id,
            whatsapp_message_id: messageId,
          });
        } catch (sendErr) {
          failed++;
          // Release lock: reset whatsapp_sent_at to null so next run can retry.
          try {
            await releaseWhatsappLock(renewal.id);
          } catch (dbErr) {
            logger.error('[sendRenewals] Could not release WhatsApp lock after send failure', {
              renewal_id: renewal.id,
              message: dbErr.message,
            });
          }
          logger.error('[sendRenewals] Failed to send WhatsApp reminder', {
            gym_id: gymId,
            renewal_id: renewal.id,
            member_id: renewal.member.id,
            message: sendErr.message,
            response_data: sendErr.response?.data ?? null,
            response_status: sendErr.response?.status ?? null,
          });
        }
      } catch (err) {
        failed++;
        logger.error('[sendRenewals] Unexpected error processing renewal', {
          gym_id: gymId,
          renewal_id: renewal.id,
          message: err.message,
        });
      }
    }

    logger.info(
      `[sendRenewals] gym_id=${gymId} complete. ` +
      `processed=${renewals.length}, success=${success}, skipped=${skipped}, failed=${failed}`
    );

    // 5. Return summary
    return sendSuccess(
      res,
      { processed: renewals.length, success, skipped, failed },
      'WhatsApp reminders processed.'
    );
  } catch (err) {
    logger.error('[sendRenewals] Unexpected error', { message: err.message, stack: err.stack });
    next(err);
  }
}

module.exports = { sendRenewals };
