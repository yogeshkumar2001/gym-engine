'use strict';

const adminService = require('../services/admin.service');
const { getReactivationStats } = require('../services/reactivationService');
const { getFunnelStats } = require('../services/leadService');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * Validates and parses gymId from req.params — shared by all admin handlers.
 * @returns {number|null}
 */
function parseGymId(req) {
  const gymId = parseInt(req.params.gymId, 10);
  return Number.isInteger(gymId) && gymId > 0 ? gymId : null;
}

/**
 * GET /admin/global-health
 * Returns platform-wide aggregated health metrics.
 * No gym_id context — reads across all tenants.
 */
async function globalHealth(req, res, next) {
  try {
    const data = await adminService.getGlobalHealth();
    return sendSuccess(res, data, 'Global health retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/gym/:gymId/deep-health
 * Returns a detailed health snapshot for one gym.
 * No credentials are returned — only operational metadata.
 */
async function gymDeepHealth(req, res, next) {
  const gymId = parseInt(req.params.gymId, 10);
  if (!Number.isInteger(gymId) || gymId <= 0) {
    return sendError(res, 'Invalid gymId.', 400);
  }

  try {
    const data = await adminService.getGymDeepHealth(gymId);
    return sendSuccess(res, data, 'Gym deep health retrieved.');
  } catch (err) {
    if (err.status === 404) {
      return sendError(res, err.message, 404);
    }
    next(err);
  }
}

/**
 * PATCH /admin/gym/:gymId/subscription
 *
 * Sets or clears the subscription expiry date for a gym.
 *
 * Body:
 *   { "subscription_expires_at": "2025-12-31T23:59:59.000Z" }  — set expiry
 *   { "subscription_expires_at": null }                          — unlimited
 *
 * The cron jobs (expiryCron, summaryCron) skip gyms whose subscription_expires_at
 * is non-null and in the past.  Setting null re-enables a lapsed gym immediately.
 */
async function updateGymSubscription(req, res, next) {
  const gymId = parseInt(req.params.gymId, 10);
  if (!Number.isInteger(gymId) || gymId <= 0) {
    return sendError(res, 'Invalid gymId.', 400);
  }

  if (!('subscription_expires_at' in req.body)) {
    return sendError(res, 'subscription_expires_at is required.', 400);
  }

  const raw = req.body.subscription_expires_at;

  let expiresAt = null;
  if (raw !== null) {
    const parsed = new Date(raw);
    if (isNaN(parsed.getTime())) {
      return sendError(res, 'subscription_expires_at must be a valid ISO 8601 date string or null.', 400);
    }
    expiresAt = parsed;
  }

  try {
    await adminService.updateGymSubscription(gymId, expiresAt);
    return sendSuccess(
      res,
      { gym_id: gymId, subscription_expires_at: expiresAt },
      'Subscription updated successfully.'
    );
  } catch (err) {
    if (err.status === 404) {
      return sendError(res, err.message, 404);
    }
    next(err);
  }
}

/**
 * GET /admin/gym/:gymId/recovery-stats
 * Returns recovery engine metrics for a gym.
 */
async function getRecoveryStats(req, res, next) {
  const gymId = parseGymId(req);
  if (!gymId) return sendError(res, 'Invalid gymId.', 400);

  try {
    const data = await adminService.getRecoveryStats(gymId);
    return sendSuccess(res, data, 'Recovery stats retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/gym/:gymId/reactivation-stats
 * Returns reactivation campaign metrics for a gym.
 */
async function getReactivationStatsHandler(req, res, next) {
  const gymId = parseGymId(req);
  if (!gymId) return sendError(res, 'Invalid gymId.', 400);

  try {
    const data = await getReactivationStats(gymId);
    return sendSuccess(res, data, 'Reactivation stats retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/gym/:gymId/lead-stats
 * Returns lead funnel statistics for a gym.
 */
async function getLeadStatsHandler(req, res, next) {
  const gymId = parseGymId(req);
  if (!gymId) return sendError(res, 'Invalid gymId.', 400);

  try {
    const data = await getFunnelStats(gymId);
    return sendSuccess(res, data, 'Lead stats retrieved.');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  globalHealth,
  gymDeepHealth,
  updateGymSubscription,
  getRecoveryStats,
  getReactivationStats: getReactivationStatsHandler,
  getLeadStats: getLeadStatsHandler,
};
