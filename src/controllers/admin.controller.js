'use strict';

const adminService = require('../services/admin.service');
const { getReactivationStats } = require('../services/reactivationService');
const { getFunnelStats } = require('../services/leadService');
const { sendSuccess, sendError } = require('../utils/response');
const prisma = require('../lib/prisma');
const { DEFAULT_SERVICES, KNOWN_SERVICES } = require('../utils/gymServices');
const logger = require('../config/logger');

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

// Member limits per tier — single source of truth
const TIER_LIMITS = {
  starter:    100,
  growth:     300,
  pro:        1000,
  enterprise: 99999,
};

const VALID_TIERS = Object.keys(TIER_LIMITS);

/**
 * PATCH /admin/gym/:gymId/subscription
 *
 * Sets or clears the subscription expiry date and optionally the tier for a gym.
 *
 * Body:
 *   { "subscription_expires_at": "2025-12-31T23:59:59.000Z" }  — set expiry
 *   { "subscription_expires_at": null }                          — unlimited
 *   { "tier": "growth" }                                         — set tier (auto-sets member_limit)
 *   Both fields may be provided together.
 */
async function updateGymSubscription(req, res, next) {
  const gymId = parseInt(req.params.gymId, 10);
  if (!Number.isInteger(gymId) || gymId <= 0) {
    return sendError(res, 'Invalid gymId.', 400);
  }

  const hasExpiry = 'subscription_expires_at' in req.body;
  const hasTier   = 'tier' in req.body;

  if (!hasExpiry && !hasTier) {
    return sendError(res, 'Provide subscription_expires_at and/or tier.', 400);
  }

  let expiresAt;
  if (hasExpiry) {
    const raw = req.body.subscription_expires_at;
    if (raw !== null) {
      const parsed = new Date(raw);
      if (isNaN(parsed.getTime())) {
        return sendError(res, 'subscription_expires_at must be a valid ISO 8601 date string or null.', 400);
      }
      expiresAt = parsed;
    } else {
      expiresAt = null;
    }
  }

  let tier;
  if (hasTier) {
    tier = req.body.tier;
    if (!VALID_TIERS.includes(tier)) {
      return sendError(res, `tier must be one of: ${VALID_TIERS.join(', ')}.`, 400);
    }
  }

  try {
    const gym = await prisma.gym.findUnique({ where: { id: gymId }, select: { id: true } });
    if (!gym) return sendError(res, 'Gym not found.', 404);

    if (hasExpiry) {
      await adminService.updateGymSubscription(gymId, expiresAt);
    }

    if (hasTier) {
      await prisma.gym.update({
        where: { id: gymId },
        data: { subscription_tier: tier, member_limit: TIER_LIMITS[tier] },
      });
    }

    const result = await prisma.gym.findUnique({
      where: { id: gymId },
      select: {
        id: true,
        subscription_expires_at: true,
        subscription_tier: true,
        member_limit: true,
      },
    });

    return sendSuccess(res, result, 'Subscription updated successfully.');
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

/**
 * GET /admin/health/whatsapp
 * Returns a WhatsApp system health snapshot:
 * - system token status + expires_at
 * - gym counts by whatsapp_status
 * - queue depth (queued messages)
 * - last 24h sent / failed / dead counts
 * - gyms with RED quality rating count
 */
async function getWhatsappHealth(_req, res, next) {
  try {
    const now = new Date();
    const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      systemToken,
      gymStatusCounts,
      queueDepth,
      last24hStats,
      redQualityCount,
    ] = await Promise.all([
      prisma.systemToken.findFirst({
        where: { token_type: 'waba_system_user', status: { in: ['active', 'expiring_soon'] } },
        orderBy: { created_at: 'desc' },
        select: { status: true, expires_at: true, last_verified: true },
      }),
      prisma.gym.groupBy({
        by: ['whatsapp_status'],
        _count: { id: true },
      }),
      prisma.messageQueue.count({ where: { status: 'queued' } }),
      prisma.messageQueue.groupBy({
        by: ['status'],
        where: {
          status: { in: ['sent', 'delivered', 'read', 'failed', 'dead'] },
          created_at: { gt: cutoff24h },
        },
        _count: { id: true },
      }),
      prisma.whatsappAccount.count({ where: { quality_rating: 'RED' } }),
    ]);

    // Flatten last24h counts
    const sent24h = last24hStats
      .filter((r) => ['sent', 'delivered', 'read'].includes(r.status))
      .reduce((acc, r) => acc + r._count.id, 0);
    const failed24h = last24hStats.find((r) => r.status === 'failed')?._count.id ?? 0;
    const dead24h   = last24hStats.find((r) => r.status === 'dead')?._count.id ?? 0;

    // Flatten gym status counts
    const gymsByStatus = Object.fromEntries(
      gymStatusCounts.map((r) => [r.whatsapp_status ?? 'not_setup', r._count.id])
    );

    return sendSuccess(res, {
      system_token: systemToken
        ? { status: systemToken.status, expires_at: systemToken.expires_at, last_verified: systemToken.last_verified }
        : { status: 'none', expires_at: null, last_verified: null },
      gyms_by_whatsapp_status: gymsByStatus,
      queue_depth: queueDepth,
      last_24h: { sent: sent24h, failed: failed24h, dead: dead24h },
      gyms_with_red_quality: redQualityCount,
    }, 'WhatsApp health retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * POST /admin/gym/:gymId/activate-whatsapp
 * Manually triggers OnboardingService.activateGym() for a gym.
 * Used by support when auto-detection fails.
 */
async function activateGymWhatsapp(req, res, next) {
  const gymId = parseGymId(req);
  if (!gymId) return sendError(res, 'Invalid gymId.', 400);

  try {
    const account = await prisma.whatsappAccount.findUnique({
      where: { gym_id: gymId },
      select: { status: true, fallback_mode: true },
    });

    if (!account) {
      return sendError(res, 'No WhatsappAccount found for this gym.', 404);
    }

    if (account.status !== 'active') {
      return sendError(res, `Cannot activate: account status is '${account.status}'. Must be 'active'.`, 422);
    }

    const { activateGym } = require('../services/whatsapp/OnboardingService');
    await activateGym(gymId);

    logger.info('[admin] activateGymWhatsapp: manually activated', { gym_id: gymId });
    return sendSuccess(res, { gym_id: gymId, fallback_mode: false }, 'Gym WhatsApp activated.');
  } catch (err) {
    next(err);
  }
}

/**
 * POST /admin/gym/:gymId/owners
 * Links an existing GymOwner to an additional gym.
 *
 * Body: { owner_id: number, role?: "owner"|"manager"|"viewer" }
 */
async function linkOwnerToGym(req, res, next) {
  const gymId = parseGymId(req);
  if (!gymId) return sendError(res, 'Invalid gymId.', 400);

  const { owner_id, role = 'owner' } = req.body;
  if (!owner_id || !Number.isInteger(Number(owner_id))) {
    return sendError(res, 'owner_id is required and must be an integer.', 400);
  }
  if (!['owner', 'manager', 'viewer'].includes(role)) {
    return sendError(res, 'role must be one of: owner, manager, viewer.', 400);
  }

  try {
    const [gym, owner] = await Promise.all([
      prisma.gym.findUnique({ where: { id: gymId }, select: { id: true } }),
      prisma.gymOwner.findUnique({ where: { id: Number(owner_id) }, select: { id: true } }),
    ]);
    if (!gym)   return sendError(res, 'Gym not found.', 404);
    if (!owner) return sendError(res, 'Owner not found.', 404);

    const access = await prisma.gymOwnerGym.upsert({
      where: { owner_id_gym_id: { owner_id: Number(owner_id), gym_id: gymId } },
      create: { owner_id: Number(owner_id), gym_id: gymId, role },
      update: { role },
    });

    return sendSuccess(res, access, 'Owner linked to gym.');
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
  linkOwnerToGym,
  getWhatsappHealth,
  activateGymWhatsapp,
};
