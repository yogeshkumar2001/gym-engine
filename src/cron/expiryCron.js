'use strict';

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { getTargetDayWindow, getFortyEightHoursAgo } = require('../utils/dateUtils');
const {
  createRenewalIfNotExists,
  markLinkGenerated,
  acquirePaymentLinkLock,
  releasePaymentLinkLock,
  acquireWhatsappLock,
  releaseWhatsappLock,
} = require('../services/renewalService');
const { createPaymentLinkForRenewal } = require('../services/razorpayService');
const { sendRenewalReminder } = require('../services/whatsappService');

/**
 * Full pipeline for a single member within a gym run:
 *
 *   Step 1 — Create renewal if none is active (pending or link_generated).
 *   Step 2 — Generate Razorpay payment link if the renewal is still pending.
 *   Step 3 — Send WhatsApp reminder if the link is ready and reminder not yet sent.
 *
 * Returns true if a WhatsApp reminder was successfully sent (used to decide
 * whether to update last_reminder_sent_at for this member).
 *
 * Throws on unrecoverable error; caller catches per-member to isolate failures.
 *
 * @param {{ id, name, razorpay_key_id, razorpay_key_secret,
 *           whatsapp_phone_number_id, whatsapp_access_token }} gym
 * @param {{ id, name, phone, plan_amount }} member
 * @param {Date} now
 * @returns {Promise<boolean>} — whether a WhatsApp reminder was sent this run
 */
async function processMember(gym, member, now) {
  // Step 1: get or create the renewal
  const { created, renewal: initialRenewal } = await createRenewalIfNotExists(gym.id, member);

  if (created) {
    logger.debug('[expiryCron] Renewal created', {
      gym_id: gym.id,
      member_id: member.id,
      renewal_id: initialRenewal.id,
    });
  }

  let renewal = initialRenewal;

  // Step 2: generate Razorpay payment link — atomic lock prevents duplicate links
  // when two cron instances or manual triggers run simultaneously.
  if (renewal.status === 'pending') {
    const linkLockAcquired = await acquirePaymentLinkLock(renewal.id);

    if (!linkLockAcquired) {
      // Another process transitioned this renewal to processing_link first.
      // Re-fetch so step 3 can still run if that process already finished.
      logger.debug('[expiryCron] Payment link lock not acquired — re-fetching renewal', {
        gym_id: gym.id,
        renewal_id: renewal.id,
        member_id: member.id,
      });
      renewal = await prisma.renewal.findUnique({ where: { id: renewal.id } });
    } else {
      // This process owns the lock — generate the link.
      // On failure, release the lock so the next run can retry from pending.
      try {
        const { paymentLinkId, shortUrl } = await createPaymentLinkForRenewal(
          gym,
          renewal,
          member
        );
        renewal = await markLinkGenerated(renewal.id, paymentLinkId, shortUrl);
        logger.info('[expiryCron] Payment link generated', {
          gym_id: gym.id,
          renewal_id: renewal.id,
          member_id: member.id,
          short_url: shortUrl,
        });
      } catch (err) {
        await releasePaymentLinkLock(renewal.id);
        throw err; // propagate — processGym's per-member catch will log it
      }
    }
  }

  // Step 3: send WhatsApp reminder — atomic lock ensures exactly one send
  // even if two processes both reach this point for the same renewal.
  if (renewal.status === 'link_generated') {
    const whatsappLockAcquired = await acquireWhatsappLock(renewal.id, now);

    if (!whatsappLockAcquired) {
      // Another process already claimed the send slot — skip.
      logger.debug('[expiryCron] WhatsApp lock not acquired — already handled by another process', {
        gym_id: gym.id,
        renewal_id: renewal.id,
        member_id: member.id,
      });
      return false;
    }

    // This process owns the send slot — call the API.
    // On failure, release the lock (reset whatsapp_sent_at) so the next run retries.
    try {
      const { messageId } = await sendRenewalReminder(gym, renewal, member);
      await prisma.renewal.update({
        where: { id: renewal.id },
        data: {
          whatsapp_message_id: messageId,
          whatsapp_status: 'sent',
        },
      });
      logger.info('[expiryCron] WhatsApp reminder sent', {
        gym_id: gym.id,
        renewal_id: renewal.id,
        member_id: member.id,
        whatsapp_message_id: messageId,
      });
      return true;
    } catch (err) {
      await releaseWhatsappLock(renewal.id);
      throw err; // propagate — processGym's per-member catch will log it
    }
  }

  return false;
}

/**
 * Processes one gym:
 * - Finds active members expiring in 3 days who haven't been recently reminded.
 * - Runs the full create → link → WhatsApp pipeline per member.
 * - Batch-updates last_reminder_sent_at for members where a reminder was sent.
 * - Isolated: a per-member failure does not affect other members in this gym.
 *
 * @param {{ id, name, razorpay_key_id, razorpay_key_secret,
 *           whatsapp_phone_number_id, whatsapp_access_token }} gym
 * @param {Date} startOfTargetDay
 * @param {Date} endOfTargetDay
 * @param {Date} fortyEightHoursAgo
 * @param {Date} now
 */
async function processGym(gym, startOfTargetDay, endOfTargetDay, fortyEightHoursAgo, now) {
  const members = await prisma.member.findMany({
    where: {
      gym_id: gym.id,
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
      plan_amount: true,
    },
  });

  if (members.length === 0) {
    logger.info(`[expiryCron] gym_id=${gym.id} "${gym.name}": no eligible members.`);
    return;
  }

  let remindersSent = 0;
  let failed = 0;
  const notifiedMemberIds = []; // members who received a WhatsApp this run

  for (const member of members) {
    try {
      const reminded = await processMember(gym, member, now);
      if (reminded) {
        remindersSent++;
        notifiedMemberIds.push(member.id);
      }
    } catch (err) {
      failed++;
      logger.error('[expiryCron] Failed to process member', {
        gym_id: gym.id,
        member_id: member.id,
        name: member.name,
        message: err.message,
        stack: err.stack,
      });
    }
  }

  // Batch-update last_reminder_sent_at only for members who were just notified.
  // This drives the 48-hour re-fetch guard on the next cron run.
  if (notifiedMemberIds.length > 0) {
    await prisma.member.updateMany({
      where: { id: { in: notifiedMemberIds } },
      data: { last_reminder_sent_at: now },
    });
  }

  logger.info(
    `[expiryCron] gym_id=${gym.id} "${gym.name}": ` +
    `eligible=${members.length}, reminders_sent=${remindersSent}, failed=${failed}`
  );
}

/**
 * Main cron handler.
 * Computes the detection window once (consistent across all gyms in this run),
 * then processes each gym independently.
 */
async function detectExpiringMembers() {
  const now = new Date();
  logger.info(`[expiryCron] Run started at ${now.toISOString()}`);

  const { startOfTargetDay, endOfTargetDay } = getTargetDayWindow(3);
  const fortyEightHoursAgo = getFortyEightHoursAgo();

  logger.debug('[expiryCron] Detection window', {
    startOfTargetDay: startOfTargetDay.toISOString(),
    endOfTargetDay: endOfTargetDay.toISOString(),
    fortyEightHoursAgo: fortyEightHoursAgo.toISOString(),
  });

  let gyms;
  try {
    gyms = await prisma.gym.findMany({
      select: {
        id: true,
        name: true,
        razorpay_key_id: true,
        razorpay_key_secret: true,
        whatsapp_phone_number_id: true,
        whatsapp_access_token: true,
      },
    });
  } catch (err) {
    logger.error('[expiryCron] Failed to fetch gyms. Aborting run.', {
      message: err.message,
      stack: err.stack,
    });
    return;
  }

  if (gyms.length === 0) {
    logger.info('[expiryCron] No gyms found. Exiting.');
    return;
  }

  logger.info(`[expiryCron] Processing ${gyms.length} gym(s).`);

  for (const gym of gyms) {
    try {
      await processGym(gym, startOfTargetDay, endOfTargetDay, fortyEightHoursAgo, now);
    } catch (err) {
      logger.error(`[expiryCron] Error processing gym_id=${gym.id} "${gym.name}". Skipping.`, {
        message: err.message,
        stack: err.stack,
      });
    }
  }

  logger.info('[expiryCron] Run complete.');
}

function initExpiryCron() {
  cron.schedule('0 9 * * *', detectExpiringMembers, {
    timezone: 'Asia/Kolkata',
  });

  logger.info('[expiryCron] Scheduled — daily at 09:00 IST.');
}

module.exports = { initExpiryCron, detectExpiringMembers };
