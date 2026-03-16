'use strict';

const adminService = require('../services/admin.service');
const { getReactivationStats } = require('../services/reactivationService');
const { getFunnelStats } = require('../services/leadService');
const { sendSuccess, sendError } = require('../utils/response');
const prisma = require('../lib/prisma');
const { DEFAULT_SERVICES, KNOWN_SERVICES } = require('../utils/gymServices');

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

/**
 * GET /admin/gyms
 * Lists all gyms with summary fields for the admin portal.
 */
async function listGyms(_req, res, next) {
  try {
    const gyms = await adminService.listGyms();
    return sendSuccess(res, { gyms, total: gyms.length }, 'Gyms retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/gym/:gymId/services
 * Returns the current service flags for a gym (merged with defaults for display).
 */
async function getGymServices(req, res, next) {
  const gymId = parseGymId(req);
  if (!gymId) return sendError(res, 'Invalid gymId.', 400);

  try {
    const gym = await prisma.gym.findUnique({
      where: { id: gymId },
      select: { id: true, services: true },
    });
    if (!gym) return sendError(res, 'Gym not found.', 404);

    // Merge stored services with defaults so the response always contains all keys
    const services = { ...DEFAULT_SERVICES, ...(gym.services || {}) };
    return sendSuccess(res, { gym_id: gymId, services }, 'Services retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /admin/gym/:gymId/services
 * Enables or disables individual services for a gym.
 *
 * Body: partial object, e.g. { "payments": false, "whatsapp_reminders": true }
 * Unknown keys are rejected. Existing keys not in the body are left unchanged.
 */
async function updateGymServices(req, res, next) {
  const gymId = parseGymId(req);
  if (!gymId) return sendError(res, 'Invalid gymId.', 400);

  const updates = req.body;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return sendError(res, 'Request body must be a JSON object.', 400);
  }

  const unknownKeys = Object.keys(updates).filter(k => !KNOWN_SERVICES.includes(k));
  if (unknownKeys.length > 0) {
    return sendError(res, `Unknown service key(s): ${unknownKeys.join(', ')}. Allowed: ${KNOWN_SERVICES.join(', ')}.`, 400);
  }

  const invalidValues = Object.entries(updates).filter(([, v]) => typeof v !== 'boolean');
  if (invalidValues.length > 0) {
    return sendError(res, 'All service values must be boolean.', 400);
  }

  try {
    const gym = await prisma.gym.findUnique({
      where: { id: gymId },
      select: { id: true, services: true },
    });
    if (!gym) return sendError(res, 'Gym not found.', 404);

    // Merge: existing services → defaults → incoming updates
    const merged = { ...DEFAULT_SERVICES, ...(gym.services || {}), ...updates };

    await prisma.gym.update({
      where: { id: gymId },
      data: { services: merged },
    });

    return sendSuccess(res, { gym_id: gymId, services: merged }, 'Services updated.');
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /admin/gym/:gymId/discounts
 * Body: { recovery_discount_percent?, reactivation_discount_percent? }
 */
async function updateGymDiscounts(req, res, next) {
  const gymId = parseGymId(req);
  if (!gymId) return sendError(res, 'Invalid gymId.', 400);

  const { recovery_discount_percent, reactivation_discount_percent } = req.body;

  if (recovery_discount_percent === undefined && reactivation_discount_percent === undefined) {
    return sendError(res, 'Provide at least one discount field.', 400);
  }

  const data = {};
  for (const [key, val] of [
    ['recovery_discount_percent', recovery_discount_percent],
    ['reactivation_discount_percent', reactivation_discount_percent],
  ]) {
    if (val === undefined) continue;
    const num = Number(val);
    if (!Number.isFinite(num) || num < 0 || num > 50) {
      return sendError(res, `${key} must be a number between 0 and 50.`, 400);
    }
    data[key] = num;
  }

  try {
    const gym = await prisma.gym.findUnique({ where: { id: gymId }, select: { id: true } });
    if (!gym) return sendError(res, 'Gym not found.', 404);

    const updated = await prisma.gym.update({
      where: { id: gymId },
      data,
      select: { id: true, recovery_discount_percent: true, reactivation_discount_percent: true },
    });
    return sendSuccess(res, updated, 'Discount settings updated.');
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
  listGyms,
  getGymServices,
  updateGymServices,
  updateGymDiscounts,
};
