'use strict';

const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../config/logger');
const { decryptGymCredentials } = require('../utils/encryption');
const {
  validateRazorpay,
  validateWhatsapp,
  validateGoogleSheet,
} = require('../services/credentialValidator');

// ─── Run-time state ───────────────────────────────────────────────────────────
// Tracks when this cron last began a run.  Module-level, so it survives across
// scheduled invocations but resets on process restart.  Consumed by admin.service
// via getLastHealthCronRunAt() to surface in the global-health endpoint.
let _lastRunAt = null;

/**
 * Returns the start timestamp of the most recent credential health check run,
 * or null if the process has not run the check since it started.
 *
 * @returns {Date|null}
 */
function getLastHealthCronRunAt() {
  return _lastRunAt;
}

// ─── Per-gym check ────────────────────────────────────────────────────────────

/**
 * Validates all three credentials for one gym.
 *
 * The three checks run in parallel (Promise.allSettled) to minimise wall-clock
 * time per gym.  Each validator catches its own errors internally, so allSettled
 * will always resolve — never reject — for each check.
 *
 * Outcome:
 *   ALL valid, was active  → last_health_check_at = now, last_error_message = null,
 *                            individual flags = true.  Status stays 'active'.
 *   ALL valid, was error   → same as above PLUS status restored to 'active' and
 *                            last_error_at cleared — self-healing recovery.
 *   ANY failed             → status = "error", last_error_message = structured summary,
 *                            last_error_at = now, individual flags reflect each result.
 *
 * Credentials are never written to logs — only error descriptions from the
 * upstream API responses are surfaced.
 *
 * @param {{ id, name, status, razorpay_key_id, razorpay_key_secret,
 *           whatsapp_phone_number_id, whatsapp_access_token,
 *           google_sheet_id }} gym   — decrypted credentials, includes current status
 * @param {Date} now
 * @returns {Promise<boolean>}  true when all credentials are valid
 */
async function checkGymCredentials(gym, now) {
  // Run all three validations concurrently — independent of each other.
  const [rzpSettled, waSettled, sheetSettled] = await Promise.allSettled([
    validateRazorpay(gym),
    validateWhatsapp(gym),
    validateGoogleSheet(gym),
  ]);

  // Each validator catches internally, so status should always be 'fulfilled'.
  // The fallback handles any unexpected thrown value defensively.
  const rzp   = rzpSettled.status   === 'fulfilled'
    ? rzpSettled.value
    : { valid: false, error: rzpSettled.reason?.message ?? 'Unexpected error.' };

  const wa    = waSettled.status    === 'fulfilled'
    ? waSettled.value
    : { valid: false, error: waSettled.reason?.message ?? 'Unexpected error.' };

  const sheet = sheetSettled.status === 'fulfilled'
    ? sheetSettled.value
    : { valid: false, error: sheetSettled.reason?.message ?? 'Unexpected error.' };

  const allValid = rzp.valid && wa.valid && sheet.valid;

  if (allValid) {
    const wasInError = gym.status === 'error';

    await prisma.gym.update({
      where: { id: gym.id },
      data: {
        // Restore to active if this gym was previously errored by the health cron.
        // 'suspended' gyms are intentionally excluded from this cron's query, so
        // the only non-active status we can see here is 'error'.
        ...(wasInError && { status: 'active', last_error_at: null }),
        last_health_check_at: now,
        last_error_message:   null,
        razorpay_valid:       true,
        whatsapp_valid:       true,
        sheet_valid:          true,
      },
    });

    if (wasInError) {
      logger.warn('[credentialHealthCron] Credentials recovered — gym restored to active', {
        gym_id:   gym.id,
        gym_name: gym.name,
      });
    } else {
      logger.info('[credentialHealthCron] Credentials valid', {
        gym_id:   gym.id,
        gym_name: gym.name,
      });
    }

    return true;
  }

  // Build a compact human-readable error summary.
  // Never include credential values — only upstream error descriptions.
  const failures = [];
  if (!rzp.valid)   failures.push(`[razorpay] ${rzp.error}`);
  if (!wa.valid)    failures.push(`[whatsapp] ${wa.error}`);
  if (!sheet.valid) failures.push(`[sheet] ${sheet.error}`);

  await prisma.gym.update({
    where: { id: gym.id },
    data: {
      status:             'error',
      last_error_message: failures.join('; '),
      last_error_at:      now,
      razorpay_valid:     rzp.valid,
      whatsapp_valid:     wa.valid,
      sheet_valid:        sheet.valid,
    },
  });

  logger.warn('[credentialHealthCron] Credential failure(s) — gym set to error', {
    gym_id:         gym.id,
    gym_name:       gym.name,
    razorpay:       rzp.valid   ? 'ok' : 'FAIL',
    whatsapp:       wa.valid    ? 'ok' : 'FAIL',
    sheet:          sheet.valid ? 'ok' : 'FAIL',
    razorpay_error: rzp.error   ?? null,
    whatsapp_error: wa.error    ?? null,
    sheet_error:    sheet.error ?? null,
  });

  return false;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

/**
 * Fetches all active and errored gyms and validates their credentials sequentially.
 *
 * 'active' gyms are checked to detect newly broken credentials.
 * 'error'  gyms are re-checked to detect recovery — enabling self-healing without
 *          manual DB intervention when an operator fixes a credential.
 * 'suspended' gyms are deliberately excluded (admin-controlled, not credential-driven).
 *
 * Sequential processing (not concurrent) keeps total outbound API call volume
 * predictable and prevents stampede against rate-limited external services
 * (Razorpay, Meta, Google) at midnight.
 *
 * Per-gym try/catch ensures one gym's unexpected failure (e.g. DB write error)
 * cannot abort the run for subsequent gyms.
 */
async function runCredentialHealthCheck() {
  const now = new Date();
  _lastRunAt = now;

  logger.info(`[credentialHealthCron] Run started at ${now.toISOString()}`);

  let gyms;
  try {
    gyms = await prisma.gym.findMany({
      where: { status: { in: ['active', 'error'] } },
      select: {
        id:                       true,
        name:                     true,
        status:                   true,   // needed to detect recovery path
        razorpay_key_id:          true,
        razorpay_key_secret:      true,
        whatsapp_phone_number_id: true,
        whatsapp_access_token:    true,
        google_sheet_id:          true,
      },
    });
    gyms = gyms.map(g => decryptGymCredentials(g));
  } catch (err) {
    logger.error('[credentialHealthCron] Failed to fetch gyms. Aborting run.', {
      message: err.message,
      stack:   err.stack,
    });
    return;
  }

  if (gyms.length === 0) {
    logger.info('[credentialHealthCron] No checkable gyms found. Exiting.');
    return;
  }

  logger.info(`[credentialHealthCron] Checking credentials for ${gyms.length} gym(s).`);

  let healthy = 0;
  let recovered = 0;
  let credentialFailures = 0;
  let unexpectedErrors = 0;

  for (const gym of gyms) {
    try {
      const wasInError = gym.status === 'error';
      const valid = await checkGymCredentials(gym, now);
      if (valid) {
        if (wasInError) recovered++;
        else healthy++;
      } else {
        credentialFailures++;
      }
    } catch (err) {
      unexpectedErrors++;
      logger.error('[credentialHealthCron] Unexpected error for gym — skipping.', {
        gym_id:  gym.id,
        message: err.message,
        stack:   err.stack,
      });
    }
  }

  logger.info('[credentialHealthCron] Run complete.', {
    total:               gyms.length,
    healthy,
    recovered,           // gyms that were 'error' and are now restored to 'active'
    credential_failures: credentialFailures,
    unexpected_errors:   unexpectedErrors,
  });
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

function initCredentialHealthCron() {
  cron.schedule('30 0 * * *', runCredentialHealthCheck, {
    timezone: 'Asia/Kolkata',
  });

  logger.info('[credentialHealthCron] Scheduled — daily at 00:30 IST.');
}

module.exports = {
  initCredentialHealthCron,
  runCredentialHealthCheck,
  getLastHealthCronRunAt,
};
