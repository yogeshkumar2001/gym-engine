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
  advanceRecoveryStep,
  applyDiscountToRenewal,
  markRecoveryCompleted,
} = require('../services/renewalService');
const { createPaymentLinkForRenewal, createDiscountedPaymentLink } = require('../services/razorpayService');
const {
  sendRenewalReminder,
  sendRenewalReminderUpi,
  sendRecoveryFollowup,
  sendDiscountOffer,
  sendFinalNotice,
} = require('../services/whatsappService');
const { decryptGymCredentials } = require('../utils/encryption');
const { isRetryEligible, getBackoffMinutes } = require('../utils/retryPolicy');
const { gymHasService } = require('../utils/gymServices');

// Discount percentage is now per-gym (gym.recovery_discount_percent).

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

  // Guard 1: dead renewals are permanently excluded — max retries exhausted.
  if (renewal.status === 'dead') {
    logger.info('[expiryCron] Skipping dead renewal', {
      gym_id: gym.id,
      member_id: member.id,
      renewal_id: renewal.id,
      retry_count: renewal.retry_count,
    });
    return false;
  }

  // Guard 2: exponential backoff — don't retry until the window has elapsed.
  if (!isRetryEligible(renewal, now)) {
    logger.debug('[expiryCron] Renewal in backoff window — skipping', {
      gym_id: gym.id,
      member_id: member.id,
      renewal_id: renewal.id,
      retry_count: renewal.retry_count,
      last_retry_at: renewal.last_retry_at,
      backoff_minutes: getBackoffMinutes(renewal.retry_count),
    });
    return false;
  }

  // Step 2: generate Razorpay payment link — atomic lock prevents duplicate links
  // when two cron instances or manual triggers run simultaneously.
  if (renewal.status === 'pending') {
    if (!gymHasService(gym, 'payments')) {
      // UPI fallback: if gym has a UPI ID and WhatsApp reminders enabled,
      // send a UPI deep link instead of a Razorpay link.
      if (gym.upi_id && gymHasService(gym, 'whatsapp_reminders')) {
        const upiUrl = `upi://pay?pa=${encodeURIComponent(gym.upi_id)}&am=${renewal.amount}&tn=GymRenewal&cu=INR`;

        const whatsappLockAcquired = await acquireWhatsappLock(renewal.id, now);
        if (!whatsappLockAcquired) {
          logger.debug('[expiryCron] UPI WhatsApp lock not acquired — already handled', {
            gym_id: gym.id, renewal_id: renewal.id, member_id: member.id,
          });
          return false;
        }

        try {
          const { messageId } = await sendRenewalReminderUpi(gym, renewal, member, upiUrl);
          await prisma.renewal.update({
            where: { id: renewal.id },
            data: {
              upi_url: upiUrl,
              payment_method: 'upi',
              whatsapp_message_id: messageId,
              whatsapp_status: 'sent',
            },
          });
          logger.info('[expiryCron] UPI reminder sent', {
            gym_id: gym.id, renewal_id: renewal.id, member_id: member.id,
          });
          return true;
        } catch (err) {
          await releaseWhatsappLock(renewal.id);
          throw err;
        }
      }

      logger.info('[expiryCron] payments disabled and no UPI ID — skipping', {
        gym_id: gym.id, renewal_id: renewal.id, member_id: member.id,
      });
      return false;
    }

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
    if (!gymHasService(gym, 'whatsapp_reminders')) {
      logger.info('[expiryCron] whatsapp_reminders disabled — skipping WA reminder', {
        gym_id: gym.id, renewal_id: renewal.id, member_id: member.id,
      });
      return false;
    }

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
 * Recovery pipeline for a renewal that has already been through the initial
 * reminder (recovery_step = 0) but the member has not yet paid.
 *
 * Step sequence (each fires ~48h after the previous, gated by last_reminder_sent_at):
 *   0 → 1  Follow-up: resend the existing payment link with a reminder message.
 *   1 → 2  Discount:  create a 5%-off payment link and send a special offer.
 *   2 → 3  Final:     send a last-chance message with the current link.
 *                     Sets recovery_completed = true — no further recovery runs.
 *
 * Uses advanceRecoveryStep() as the atomic lock: exactly one concurrent caller
 * can advance from step N to N+1 (same MySQL serialization as acquirePaymentLinkLock).
 * On WhatsApp failure the step advance is NOT rolled back — the member misses
 * that specific follow-up but the recovery sequence continues on the next run.
 *
 * @param {{ id, razorpay_key_id, razorpay_key_secret,
 *           whatsapp_phone_number_id, whatsapp_access_token }} gym
 * @param {{ id, recovery_step, razorpay_short_url }} renewal
 * @param {{ id, name, phone }} member
 * @param {Date} now
 * @returns {Promise<boolean>} true if a message was sent this run
 */
async function processRecovery(gym, renewal, member, now) {
  if (!gymHasService(gym, 'whatsapp_reminders')) {
    logger.info('[expiryCron] whatsapp_reminders disabled — skipping recovery message', {
      gym_id: gym.id, renewal_id: renewal.id, member_id: member.id,
    });
    return false;
  }

  const fromStep = renewal.recovery_step;
  const toStep = fromStep + 1;

  // Atomically claim this step — prevents double-processing across concurrent runs
  const advanced = await advanceRecoveryStep(renewal.id, fromStep, toStep);
  if (!advanced) {
    logger.debug('[expiryCron] Recovery step already advanced by another process', {
      gym_id: gym.id, renewal_id: renewal.id, member_id: member.id, fromStep, toStep,
    });
    return false;
  }

  try {
    let messageId = null;

    if (toStep === 1) {
      // Follow-up: same link, different message
      ({ messageId } = await sendRecoveryFollowup(gym, renewal, member));

    } else if (toStep === 2) {
      // Discount: create new Razorpay link at reduced price (per-gym configurable %)
      const discountPct = gym.recovery_discount_percent ?? 5;
      const discountedAmount =
        Math.round(renewal.amount * (1 - discountPct / 100) * 100) / 100;

      const { paymentLinkId, shortUrl } = await createDiscountedPaymentLink(
        gym, renewal, member, discountedAmount
      );
      await applyDiscountToRenewal(
        renewal.id, paymentLinkId, shortUrl, discountPct, discountedAmount
      );
      // Send with the NEW short URL
      ({ messageId } = await sendDiscountOffer(
        gym, { ...renewal, razorpay_short_url: shortUrl }, member, discountPct
      ));

    } else if (toStep === 3) {
      // Final notice — use whatever short URL is currently on the renewal
      // (may be the discounted link from step 2)
      const latestRenewal = await prisma.renewal.findUnique({
        where: { id: renewal.id },
        select: { razorpay_short_url: true },
      });
      ({ messageId } = await sendFinalNotice(
        gym, { ...renewal, razorpay_short_url: latestRenewal.razorpay_short_url }, member
      ));
      await markRecoveryCompleted(renewal.id);
    }

    // Stamp the renewal's last whatsapp fields for tracking
    await prisma.renewal.update({
      where: { id: renewal.id },
      data: { whatsapp_message_id: messageId, whatsapp_sent_at: now, whatsapp_status: 'sent' },
    });

    logger.info('[expiryCron] Recovery message sent', {
      gym_id: gym.id, renewal_id: renewal.id, member_id: member.id, step: toStep,
    });
    return true;

  } catch (err) {
    // Step was already advanced — don't revert. Log the send failure and move on.
    // The recovery sequence continues from the advanced step on the next cron run.
    logger.error('[expiryCron] Recovery message failed — step advanced but send failed', {
      gym_id: gym.id, renewal_id: renewal.id, member_id: member.id, step: toStep,
      message: err.message,
    });
    return false;
  }
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
      plan_duration_days: true,
    },
  });

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
      const apiDetail = JSON.stringify(err.response?.data ?? err.error ?? null);
      logger.error(
        `[expiryCron] Failed to process member id=${member.id} "${member.name}" — ${err.message} | api: ${apiDetail}`,
        { stack: err.stack }
      );
    }
  }

  // ── Recovery: follow-up for members who got an initial reminder but haven't paid ──
  //
  // Finds link_generated renewals where:
  //   - recovery not yet completed
  //   - step is 0-2 (step 3 triggers markRecoveryCompleted, never re-runs)
  //   - previous WhatsApp was sent (whatsapp_status = 'sent' — guards against
  //     re-running after a send failure that left recovery_step already advanced)
  //   - member hasn't been reminded in the last 48 hours
  const recoveryRenewals = await prisma.renewal.findMany({
    where: {
      gym_id: gym.id,
      status: 'link_generated',
      recovery_completed: false,
      recovery_step: { lt: 3 },
      whatsapp_status: 'sent',
      member: {
        OR: [
          { last_reminder_sent_at: null },
          { last_reminder_sent_at: { lte: fortyEightHoursAgo } },
        ],
      },
    },
    include: {
      member: {
        select: { id: true, name: true, phone: true, expiry_date: true, plan_amount: true },
      },
    },
  });

  for (const renewal of recoveryRenewals) {
    const { member: recoveryMember } = renewal;
    try {
      const notified = await processRecovery(gym, renewal, recoveryMember, now);
      if (notified) {
        remindersSent++;
        if (!notifiedMemberIds.includes(recoveryMember.id)) {
          notifiedMemberIds.push(recoveryMember.id);
        }
      }
    } catch (err) {
      failed++;
      logger.error(
        `[expiryCron] Recovery error for member id=${recoveryMember.id} "${recoveryMember.name}" — ${err.message}`,
        { stack: err.stack }
      );
    }
  }

  // Batch-update last_reminder_sent_at for all members who received any message
  // (initial reminder or recovery follow-up) — drives the 48-hour re-fetch gate.
  if (notifiedMemberIds.length > 0) {
    await prisma.member.updateMany({
      where: { id: { in: notifiedMemberIds } },
      data: { last_reminder_sent_at: now },
    });
  }

  if (members.length === 0 && recoveryRenewals.length === 0) {
    logger.info(`[expiryCron] gym_id=${gym.id} "${gym.name}": no eligible members or recovery candidates.`);
    return;
  }

  logger.info(
    `[expiryCron] gym_id=${gym.id} "${gym.name}": ` +
    `eligible=${members.length}, recovery_candidates=${recoveryRenewals.length}, ` +
    `reminders_sent=${remindersSent}, failed=${failed}`
  );
}

// Module-level lock — prevents concurrent runs if a cron tick fires while the
// previous run is still executing (e.g. many gyms, slow APIs).
let _isRunning = false;

/**
 * Main cron handler.
 * Computes the detection window once (consistent across all gyms in this run),
 * then processes each gym independently.
 */
async function detectExpiringMembers() {
  if (_isRunning) {
    logger.warn('[expiryCron] Previous run still active — skipping this tick.');
    return;
  }
  _isRunning = true;
  try {
    const now = new Date();
    logger.info(`[expiryCron] Run started at ${now.toISOString()}`);

    // ── Stuck renewal cleanup ──────────────────────────────────────────────
    // Renewals in 'processing_link' for > 1 hour mean the process crashed after
    // acquiring the lock but before Razorpay responded. Reset to 'pending' so
    // this run can pick them up and retry.
    try {
      const stuckCutoff = new Date(now.getTime() - 60 * 60 * 1000);
      const stuckResult = await prisma.renewal.updateMany({
        where: { status: 'processing_link', updated_at: { lt: stuckCutoff } },
        data: { status: 'pending' },
      });
      if (stuckResult.count > 0) {
        logger.warn(`[expiryCron] Reset ${stuckResult.count} stuck processing_link renewal(s) to pending.`);
      }
    } catch (err) {
      logger.error('[expiryCron] Failed to clean up stuck renewals.', { message: err.message });
    }

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
        where: {
          status: 'active',
          // Subscription gate: include gyms with no expiry (unlimited/grandfathered)
          // or those whose subscription has not yet lapsed.
          OR: [
            { subscription_expires_at: null },
            { subscription_expires_at: { gt: now } },
          ],
        },
        select: {
          id: true,
          name: true,
          razorpay_key_id: true,
          razorpay_key_secret: true,
          whatsapp_phone_number_id: true,
          whatsapp_access_token: true,
          services: true,
          recovery_discount_percent: true,
          upi_id: true,
        },
      });
      gyms = gyms.map(g => decryptGymCredentials(g));
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
  } finally {
    _isRunning = false;
  }
}

function initExpiryCron() {
  const task = cron.schedule('0 9 * * *', detectExpiringMembers, {
    timezone: 'Asia/Kolkata',
  });

  logger.info('[expiryCron] Scheduled — daily at 09:00 IST.');
  return task;
}

module.exports = { initExpiryCron, detectExpiringMembers };
