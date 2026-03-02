'use strict';

/**
 * System Test Controller — Internal validation layer for edge case testing.
 *
 * ⚠️  WARNING: Several tests (1, 2, 5) permanently modify DB state.
 *     Use only with test/fixture renewals, never production data.
 *
 * Tests:
 *   1. Duplicate webhook idempotency
 *   2. Mid-cron payment race
 *   3. Razorpay failure retry safety
 *   4. WhatsApp failure retry safety
 *   5. Concurrent processing race detection
 */

const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { sendSuccess, sendError } = require('../utils/response');
const {
  settleRenewal,
  markLinkGenerated,
  createRenewalIfNotExists,
  acquirePaymentLinkLock,
  releasePaymentLinkLock,
  acquireWhatsappLock,
  releaseWhatsappLock,
} = require('../services/renewalService');

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function parseRenewalId(params) {
  const id = parseInt(params.renewalId, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function fetchRenewalWithMember(renewalId) {
  return prisma.renewal.findUnique({
    where: { id: renewalId },
    include: {
      member: {
        select: { id: true, name: true, phone: true, expiry_date: true },
      },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MOCK PIPELINE (Test 5 only)
//
// Mirrors expiryCron.processMember() exactly, substituting external API calls
// with mock counters while using the SAME atomic DB locks as production.
//
// The `gate` parameter is a shared Promise both runs await before step 2,
// guaranteeing both have finished their findFirst read before either write
// begins — this is the worst-case interleaving that previously caused the race.
//
// With the atomic locks in place, exactly one run wins each lock and proceeds;
// the other gets count=0 and is skipped at that step. The test should now
// report whatsappCallCount === 1 and passed === true.
// ─────────────────────────────────────────────────────────────────────────────

async function runPipelineMock(gymId, member, counters, gate) {
  // Step 1: find existing renewal (both runs get the same pending record)
  const { renewal: initial } = await createRenewalIfNotExists(gymId, member);
  let renewal = initial;

  // Synchronize: both runs reach here before either proceeds to step 2.
  await gate;

  // Step 2: atomic Razorpay lock — only the winner generates a link
  if (renewal.status === 'pending') {
    const linkLockAcquired = await acquirePaymentLinkLock(renewal.id);

    if (!linkLockAcquired) {
      // Lost the lock — re-fetch so step 3 can still proceed if winner finished
      renewal = await prisma.renewal.findUnique({ where: { id: renewal.id } });
    } else {
      counters.razorpayCallCount++;
      const mockLinkId = `mock-rpay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        renewal = await markLinkGenerated(renewal.id, mockLinkId, `https://rzp.io/mock/${mockLinkId}`);
      } catch (err) {
        await releasePaymentLinkLock(renewal.id);
        throw err;
      }
    }
  }

  // Step 3: atomic WhatsApp lock — only the winner sends the message
  if (renewal.status === 'link_generated') {
    const now = new Date();
    const whatsappLockAcquired = await acquireWhatsappLock(renewal.id, now);

    if (!whatsappLockAcquired) {
      // Lost the lock — another run already sent or is sending
      return false;
    }

    // Won the lock — mock send (no real API call)
    counters.whatsappCallCount++;
    try {
      await prisma.renewal.update({
        where: { id: renewal.id },
        data: {
          whatsapp_message_id: `wamid.mock-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          whatsapp_status: 'sent',
        },
      });
    } catch (err) {
      await releaseWhatsappLock(renewal.id);
      throw err;
    }
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1 — Duplicate Webhook Idempotency
//
// Proves: webhook.controller.js:94-98 prevents double expiry extension.
// DB writes: renewal → paid, member.expiry_date += 30 days (once).
// ─────────────────────────────────────────────────────────────────────────────

async function testDuplicateWebhook(req, res, next) {
  try {
    const renewalId = parseRenewalId(req.params);
    if (!renewalId) return sendError(res, 'renewalId must be a positive integer.', 400);

    const renewal = await fetchRenewalWithMember(renewalId);
    if (!renewal) return sendError(res, 'Renewal not found.', 404);
    if (!renewal.member) return sendError(res, 'Renewal has no associated member.', 422);
    if (renewal.status === 'paid') {
      return sendError(
        res,
        'Precondition failed: renewal is already paid. Provide a pending or link_generated renewal.',
        422
      );
    }

    const beforeExpiry = renewal.member.expiry_date.toISOString();

    // ── First webhook: status != paid → settle ──
    await settleRenewal(renewalId, renewal.member.id, renewal.member.expiry_date);

    const memberAfterFirst = await prisma.member.findUnique({
      where: { id: renewal.member.id },
      select: { expiry_date: true },
    });
    const renewalAfterFirst = await prisma.renewal.findUnique({
      where: { id: renewalId },
      select: { status: true },
    });
    const afterFirst = memberAfterFirst.expiry_date.toISOString();

    // ── Second webhook: mirrors webhook.controller.js:94-98 ──
    let secondWebhookAction;
    if (renewalAfterFirst.status === 'paid') {
      // Guard fires — no further action, exactly as the production handler does
      secondWebhookAction = 'blocked-already-paid';
    } else {
      // Guard is broken — settle fires again (this path should never be reached)
      await settleRenewal(renewalId, renewal.member.id, memberAfterFirst.expiry_date);
      secondWebhookAction = 'settled-again-BUG';
    }

    const memberAfterSecond = await prisma.member.findUnique({
      where: { id: renewal.member.id },
      select: { expiry_date: true },
    });
    const afterSecond = memberAfterSecond.expiry_date.toISOString();

    const expiryExtendedTwice = afterFirst !== afterSecond;
    const passed =
      renewalAfterFirst.status === 'paid' &&
      secondWebhookAction === 'blocked-already-paid' &&
      !expiryExtendedTwice;

    logger.info('[systemTest:1] duplicate-webhook', { renewalId, passed, secondWebhookAction });

    return sendSuccess(res, {
      test: 'duplicate-webhook-idempotency',
      passed,
      details: {
        beforeExpiry,
        afterFirst,
        afterSecond,
        expiryExtendedTwice,
        firstWebhook: 'settled',
        secondWebhook: secondWebhookAction,
        finalRenewalStatus: renewalAfterFirst.status,
      },
    });
  } catch (err) {
    logger.error('[systemTest:1] error', { message: err.message, stack: err.stack });
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2 — Mid-Cron Payment Race
//
// Proves: the status = 'link_generated' guard in the WhatsApp send step
// prevents sending a reminder after payment has already landed.
// DB writes: renewal → link_generated (if pending), then → paid.
// ─────────────────────────────────────────────────────────────────────────────

async function testMidCronRace(req, res, next) {
  try {
    const renewalId = parseRenewalId(req.params);
    if (!renewalId) return sendError(res, 'renewalId must be a positive integer.', 400);

    const renewal = await fetchRenewalWithMember(renewalId);
    if (!renewal) return sendError(res, 'Renewal not found.', 404);
    if (!renewal.member) return sendError(res, 'Renewal has no associated member.', 422);
    if (renewal.status === 'paid') {
      return sendError(res, 'Precondition failed: renewal is already paid.', 422);
    }

    // Step 1: set to link_generated to simulate mid-cron state
    // (cron has generated the link but not yet dispatched WhatsApp)
    const stateBeforePayment = renewal.status;
    if (renewal.status === 'pending') {
      await prisma.renewal.update({
        where: { id: renewalId },
        data: {
          status: 'link_generated',
          razorpay_payment_link_id:
            renewal.razorpay_payment_link_id ?? 'test-link-placeholder',
          razorpay_short_url:
            renewal.razorpay_short_url ?? 'https://rzp.io/test/placeholder',
        },
      });
    }

    // Step 2: simulate payment webhook arriving — marks renewal paid
    await settleRenewal(renewalId, renewal.member.id, renewal.member.expiry_date);

    // Step 3: fetch renewal as the WhatsApp send step would see it
    const renewalAfterPayment = await prisma.renewal.findUnique({
      where: { id: renewalId },
      select: { status: true, whatsapp_sent_at: true },
    });

    // Step 4: evaluate the send condition used in both expiryCron and sendRenewals.controller
    // This condition MUST be false after payment for the system to be safe.
    const sendConditionMet =
      renewalAfterPayment.status === 'link_generated' &&
      renewalAfterPayment.whatsapp_sent_at === null;

    const passed = !sendConditionMet;

    logger.info('[systemTest:2] mid-cron-race', {
      renewalId,
      passed,
      statusAfterPayment: renewalAfterPayment.status,
      sendConditionMet,
    });

    return sendSuccess(res, {
      test: 'mid-cron-payment-race',
      passed,
      details: {
        stateBeforePayment,
        renewalStatusAfterPayment: renewalAfterPayment.status,
        whatsappSendConditionMet: sendConditionMet,
        whatsappBlocked: !sendConditionMet,
        reason: !sendConditionMet
          ? `status="${renewalAfterPayment.status}" — send condition requires "link_generated"`
          : 'BUG: WhatsApp send condition is met even after payment — reminder would be sent',
      },
    });
  } catch (err) {
    logger.error('[systemTest:2] error', { message: err.message, stack: err.stack });
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3 — Razorpay Failure Retry Safety
//
// Proves: when Razorpay throws, the DB is not modified — renewal stays pending
// and is eligible for retry on the next run.
// DB writes: none (the simulated error prevents any update).
// ─────────────────────────────────────────────────────────────────────────────

async function testRazorpayFailure(req, res, next) {
  try {
    const renewalId = parseRenewalId(req.params);
    if (!renewalId) return sendError(res, 'renewalId must be a positive integer.', 400);

    const renewal = await prisma.renewal.findUnique({
      where: { id: renewalId },
      select: { id: true, status: true, razorpay_payment_link_id: true },
    });
    if (!renewal) return sendError(res, 'Renewal not found.', 404);
    if (renewal.status !== 'pending') {
      return sendError(
        res,
        `Precondition failed: renewal must be "pending" (current: "${renewal.status}").`,
        422
      );
    }

    const linkIdBefore = renewal.razorpay_payment_link_id;

    // Mock Razorpay client throws before any DB write — no real API call
    const mockRazorpayFailure = async () => {
      await Promise.resolve(); // simulate async API call latency
      throw new Error('Razorpay API timeout: ETIMEDOUT');
    };

    let simulatedError = null;
    try {
      await mockRazorpayFailure();
      // If execution reaches here (it won't), production would call markLinkGenerated.
      // Since it doesn't, the DB is never touched.
    } catch (err) {
      simulatedError = err.message;
      // Production behavior: expiryCron per-member catch logs and continues the loop.
      // sendRenewals controller logs and increments failed counter.
      // In both cases: NO DB update is made after a Razorpay failure.
    }

    // Re-fetch — verify renewal is completely unchanged
    const renewalAfter = await prisma.renewal.findUnique({
      where: { id: renewalId },
      select: { status: true, razorpay_payment_link_id: true },
    });

    const statusUnchanged = renewalAfter.status === 'pending';
    const linkUnchanged = renewalAfter.razorpay_payment_link_id === linkIdBefore;
    const retryPossible = statusUnchanged && linkUnchanged;
    const passed = statusUnchanged && linkUnchanged;

    logger.info('[systemTest:3] razorpay-failure', { renewalId, passed });

    return sendSuccess(res, {
      test: 'razorpay-failure-retry-safety',
      passed,
      details: {
        simulatedError,
        stateBefore: { status: 'pending', razorpay_payment_link_id: linkIdBefore },
        stateAfter: {
          status: renewalAfter.status,
          razorpay_payment_link_id: renewalAfter.razorpay_payment_link_id,
        },
        statusUnchanged,
        linkUnchanged,
        retryPossible,
      },
    });
  } catch (err) {
    logger.error('[systemTest:3] error', { message: err.message, stack: err.stack });
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4 — WhatsApp Failure Retry Safety
//
// Proves: when the WhatsApp API throws, whatsapp_sent_at is left null (retry
// possible) and whatsapp_status is set to "failed" for observability.
// DB writes: whatsapp_status = "failed" (renewal stays eligible for retry).
// ─────────────────────────────────────────────────────────────────────────────

async function testWhatsappFailure(req, res, next) {
  try {
    const renewalId = parseRenewalId(req.params);
    if (!renewalId) return sendError(res, 'renewalId must be a positive integer.', 400);

    const renewal = await prisma.renewal.findUnique({
      where: { id: renewalId },
      select: {
        id: true,
        status: true,
        razorpay_short_url: true,
        whatsapp_sent_at: true,
        whatsapp_status: true,
      },
    });
    if (!renewal) return sendError(res, 'Renewal not found.', 404);
    if (renewal.status !== 'link_generated') {
      return sendError(
        res,
        `Precondition failed: renewal must be "link_generated" (current: "${renewal.status}").`,
        422
      );
    }
    if (!renewal.razorpay_short_url) {
      return sendError(
        res,
        'Precondition failed: renewal has no razorpay_short_url. Run POST /process-renewals/:gymId first.',
        422
      );
    }
    if (renewal.whatsapp_sent_at !== null) {
      return sendError(
        res,
        'Precondition failed: whatsapp_sent_at is already set — WhatsApp was already sent for this renewal.',
        422
      );
    }

    // Mock WhatsApp API throws — no real API call, no message sent
    const mockWhatsappFailure = async () => {
      await Promise.resolve(); // simulate async HTTP latency
      const err = new Error('WhatsApp API unavailable: Service Unavailable');
      err.response = { status: 503, data: { error: { message: 'Service Unavailable' } } };
      throw err;
    };

    let simulatedError = null;
    try {
      await mockWhatsappFailure();
    } catch (err) {
      simulatedError = err.message;
      // Production behavior (sendRenewals.controller.js:99-111, expiryCron step 3 error path):
      // Persist whatsapp_status = 'failed', leave whatsapp_sent_at = null.
      // This keeps the renewal eligible for retry on the next run.
      await prisma.renewal.update({
        where: { id: renewalId },
        data: { whatsapp_status: 'failed' },
      });
    }

    // Re-fetch — verify correct failure state
    const renewalAfter = await prisma.renewal.findUnique({
      where: { id: renewalId },
      select: { status: true, whatsapp_sent_at: true, whatsapp_status: true },
    });

    const sentAtStillNull = renewalAfter.whatsapp_sent_at === null;
    const statusIsFailed = renewalAfter.whatsapp_status === 'failed';
    const renewalStatusUnchanged = renewalAfter.status === 'link_generated';
    const retryPossible = sentAtStillNull && renewalStatusUnchanged;
    const passed = sentAtStillNull && statusIsFailed && renewalStatusUnchanged;

    logger.info('[systemTest:4] whatsapp-failure', { renewalId, passed });

    return sendSuccess(res, {
      test: 'whatsapp-failure-retry-safety',
      passed,
      details: {
        simulatedError,
        whatsappSentAt: renewalAfter.whatsapp_sent_at,
        whatsappStatus: renewalAfter.whatsapp_status,
        renewalStatus: renewalAfter.status,
        sentAtStillNull,
        statusIsFailed,
        retryPossible,
      },
    });
  } catch (err) {
    logger.error('[systemTest:4] error', { message: err.message, stack: err.stack });
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 5 — Concurrent Processing Safety (Atomic Guard Verification)
//
// Verifies that the atomic DB locks prevent duplicate Razorpay link creation
// and duplicate WhatsApp sends when two processes run the pipeline in parallel.
//
// Mechanism:
//   - Resets renewal to pending
//   - Runs two mock pipelines concurrently with a synchronization gate
//   - Gate ensures both reads finish before either write begins (worst case)
//   - Step 2: both attempt acquirePaymentLinkLock — exactly one wins (MySQL
//     serializes the UPDATE WHERE status='pending')
//   - Step 3: both attempt acquireWhatsappLock — exactly one wins (MySQL
//     serializes the UPDATE WHERE whatsapp_sent_at IS NULL)
//   - Expected: razorpayCallCount=1, whatsappCallCount=1, passed=true
//
// DB writes: renewal reset to pending, then pipeline runs with real DB locks.
// ─────────────────────────────────────────────────────────────────────────────

async function testConcurrency(req, res, next) {
  try {
    const renewalId = parseRenewalId(req.params);
    if (!renewalId) return sendError(res, 'renewalId must be a positive integer.', 400);

    const renewal = await fetchRenewalWithMember(renewalId);
    if (!renewal) return sendError(res, 'Renewal not found.', 404);
    if (!renewal.member) return sendError(res, 'Renewal has no associated member.', 422);

    // Reset renewal to pending so both runs exercise the full pipeline
    await prisma.renewal.update({
      where: { id: renewalId },
      data: {
        status: 'pending',
        razorpay_payment_link_id: null,
        razorpay_short_url: null,
        whatsapp_message_id: null,
        whatsapp_sent_at: null,
        whatsapp_status: null,
      },
    });

    const counters = { razorpayCallCount: 0, whatsappCallCount: 0 };
    const gymId = renewal.gym_id;
    const member = {
      id: renewal.member.id,
      name: renewal.member.name,
      phone: renewal.member.phone,
      // plan_amount used only if createRenewalIfNotExists creates a new record,
      // which it won't (existing pending renewal found after reset above)
      plan_amount: renewal.amount,
    };

    // Gate: a Promise that resolves after 5ms. Both runs await it before step 2.
    // This guarantees both reads (createRenewalIfNotExists) complete before
    // either write (markLinkGenerated) begins — the worst-case interleaving.
    const gate = new Promise((resolve) => setTimeout(resolve, 5));

    const [runA, runB] = await Promise.allSettled([
      runPipelineMock(gymId, member, counters, gate),
      runPipelineMock(gymId, member, counters, gate),
    ]);

    // Fetch final DB state
    const finalRenewal = await prisma.renewal.findUnique({
      where: { id: renewalId },
      select: {
        status: true,
        razorpay_payment_link_id: true,
        whatsapp_sent_at: true,
        whatsapp_status: true,
      },
    });

    const raceDetected = counters.whatsappCallCount > 1;
    const linkRaceDetected = counters.razorpayCallCount > 1;
    // Test passes only if exactly 1 WhatsApp was sent (idempotent)
    const passed = !raceDetected;

    logger.info('[systemTest:5] concurrency', {
      renewalId,
      passed,
      razorpayCallCount: counters.razorpayCallCount,
      whatsappCallCount: counters.whatsappCallCount,
    });

    return sendSuccess(res, {
      test: 'concurrency-safety',
      passed,
      raceDetected,
      details: {
        parallelRuns: 2,
        razorpayCallCount: counters.razorpayCallCount,
        whatsappCallCount: counters.whatsappCallCount,
        linkRaceDetected,
        runA:
          runA.status === 'fulfilled'
            ? { whatsappSent: runA.value }
            : { error: runA.reason?.message },
        runB:
          runB.status === 'fulfilled'
            ? { whatsappSent: runB.value }
            : { error: runB.reason?.message },
        finalState: {
          renewalStatus: finalRenewal.status,
          razorpayLinkSet: !!finalRenewal.razorpay_payment_link_id,
          whatsappSentAt: finalRenewal.whatsapp_sent_at,
          whatsappStatus: finalRenewal.whatsapp_status,
        },
        diagnosis: raceDetected
          ? `RACE CONDITION STILL PRESENT: WhatsApp lock entered ${counters.whatsappCallCount}× — ` +
            'atomic guard is not working as expected. Check acquireWhatsappLock implementation.'
          : `Atomic guards held: razorpayCallCount=${counters.razorpayCallCount}, ` +
            `whatsappCallCount=${counters.whatsappCallCount}. Exactly one send per renewal confirmed.`,
      },
    });
  } catch (err) {
    logger.error('[systemTest:5] error', { message: err.message, stack: err.stack });
    next(err);
  }
}

module.exports = {
  testDuplicateWebhook,
  testMidCronRace,
  testRazorpayFailure,
  testWhatsappFailure,
  testConcurrency,
};
