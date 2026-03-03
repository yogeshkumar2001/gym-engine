'use strict';

/**
 * Maximum number of retry attempts before a renewal is marked "dead".
 *
 * Timeline with MAX_RETRY = 5:
 *   attempt 0 (initial)  → immediate — retry_count stays 0, last_retry_at null
 *   1st failure          → retry_count = 1, backoff = 2^1 = 2 min
 *   2nd failure          → retry_count = 2, backoff = 2^2 = 4 min
 *   3rd failure          → retry_count = 3, backoff = 2^3 = 8 min
 *   4th failure          → retry_count = 4, backoff = 2^4 = 16 min
 *   5th failure          → retry_count = 5, >= MAX_RETRY → status = "dead"
 */
const MAX_RETRY = 5;

/**
 * Exponential backoff delay in minutes for a given retry_count.
 * Formula: 2 ^ retry_count
 *
 *   retry_count = 1 → 2 min
 *   retry_count = 2 → 4 min
 *   retry_count = 3 → 8 min
 *   retry_count = 4 → 16 min
 *
 * @param {number} retryCount  — the current retry_count AFTER the failure
 * @returns {number} delay in minutes
 */
function getBackoffMinutes(retryCount) {
  return Math.pow(2, retryCount);
}

/**
 * Returns true if a renewal is eligible to be processed right now.
 *
 * Rules:
 *   1. retry_count < MAX_RETRY          — not exhausted
 *   2. last_retry_at is null            — never failed (fresh renewal, always eligible)
 *      OR elapsed >= backoff window     — enough time has passed since last failure
 *
 * @param {{ retry_count: number, last_retry_at: Date|null }} renewal
 * @param {Date} now
 * @returns {boolean}
 */
function isRetryEligible(renewal, now) {
  if (renewal.retry_count >= MAX_RETRY) return false;
  if (!renewal.last_retry_at) return true;

  const backoffMs = getBackoffMinutes(renewal.retry_count) * 60 * 1000;
  return (now.getTime() - new Date(renewal.last_retry_at).getTime()) >= backoffMs;
}

module.exports = { MAX_RETRY, getBackoffMinutes, isRetryEligible };
