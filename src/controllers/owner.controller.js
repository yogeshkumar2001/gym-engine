'use strict';

const healthService = require('../services/health.service');
const { syncGymMembers } = require('../services/sync.service');
const { updateCredentials } = require('../services/onboarding.service');
const { sendSuccess, sendError } = require('../utils/response');
const { DEFAULT_SERVICES, KNOWN_SERVICES } = require('../utils/gymServices');
const prisma = require('../lib/prisma');
const logger = require('../config/logger');

async function getHealth(req, res, next) {
  try {
    const health = await healthService.getGymHealth(req.gymOwner.gym_id);
    return sendSuccess(res, health, 'Gym health retrieved.');
  } catch (err) {
    next(err);
  }
}

async function triggerSync(req, res) {
  const gymId = req.gymOwner.gym_id;
  // Return immediately — sync can take 30-60s for large sheets and would
  // exceed the client's 15s axios timeout if awaited synchronously.
  res.status(202).json({ success: true, message: 'Sync started. Check the dashboard for the updated last-synced time.' });

  setImmediate(async () => {
    try {
      await syncGymMembers(gymId);
    } catch (err) {
      logger.error('[triggerSync] Background sync failed', { gym_id: gymId, message: err.message });
    }
  });
}

async function patchCredentials(req, res, next) {
  const allowed = [
    'razorpay_key_id', 'razorpay_key_secret', 'razorpay_webhook_secret',
    'whatsapp_phone_number_id', 'whatsapp_access_token', 'google_sheet_id',
  ];
  const fields = {};
  for (const key of allowed) {
    if (req.body[key] && typeof req.body[key] === 'string' && req.body[key].trim()) {
      fields[key] = req.body[key].trim();
    }
  }
  if (Object.keys(fields).length === 0) {
    return sendError(res, 'No credential fields provided.', 400);
  }
  try {
    const result = await updateCredentials(req.gymOwner.gym_id, fields);
    return sendSuccess(res, result, 'Credentials updated.');
  } catch (err) {
    if (err.status === 400) return sendError(res, err.message, 400);
    next(err);
  }
}

async function getServices(req, res, next) {
  try {
    const gym = await prisma.gym.findUnique({
      where: { id: req.gymOwner.gym_id },
      select: { services: true },
    });
    if (!gym) return sendError(res, 'Gym not found.', 404);
    const merged = { ...DEFAULT_SERVICES, ...(gym.services || {}) };
    return sendSuccess(res, merged, 'Services retrieved.');
  } catch (err) {
    next(err);
  }
}

async function updateServices(req, res, next) {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return sendError(res, 'Request body must be a JSON object.', 400);
    }

    const unknownKeys = Object.keys(updates).filter((k) => !KNOWN_SERVICES.includes(k));
    if (unknownKeys.length > 0) {
      return sendError(res, `Unknown service keys: ${unknownKeys.join(', ')}.`, 400);
    }

    const nonBooleans = Object.entries(updates).filter(([, v]) => typeof v !== 'boolean');
    if (nonBooleans.length > 0) {
      return sendError(res, 'All service values must be boolean.', 400);
    }

    const gym = await prisma.gym.findUnique({
      where: { id: req.gymOwner.gym_id },
      select: { services: true },
    });
    if (!gym) return sendError(res, 'Gym not found.', 404);

    const merged = { ...DEFAULT_SERVICES, ...(gym.services || {}), ...updates };
    await prisma.gym.update({
      where: { id: req.gymOwner.gym_id },
      data: { services: merged },
    });

    return sendSuccess(res, merged, 'Services updated.');
  } catch (err) {
    next(err);
  }
}

async function getSubscription(req, res, next) {
  try {
    const gym = await prisma.gym.findUnique({
      where: { id: req.gymOwner.gym_id },
      select: {
        subscription_tier: true,
        member_limit: true,
        subscription_expires_at: true,
      },
    });
    if (!gym) return sendError(res, 'Gym not found.', 404);

    const member_count = await prisma.member.count({
      where: { gym_id: req.gymOwner.gym_id, deleted_at: null },
    });

    return sendSuccess(res, {
      subscription_tier:       gym.subscription_tier,
      member_limit:            gym.member_limit,
      member_count,
      subscription_expires_at: gym.subscription_expires_at,
    }, 'Subscription info retrieved.');
  } catch (err) {
    next(err);
  }
}

async function getUpiSettings(req, res, next) {
  try {
    const gym = await prisma.gym.findUnique({
      where: { id: req.gymOwner.gym_id },
      select: { upi_id: true },
    });
    if (!gym) return sendError(res, 'Gym not found.', 404);
    return sendSuccess(res, { upi_id: gym.upi_id ?? null }, 'UPI settings retrieved.');
  } catch (err) {
    next(err);
  }
}

async function updateUpiSettings(req, res, next) {
  try {
    const { upi_id } = req.body;
    if (upi_id !== null && upi_id !== undefined) {
      if (typeof upi_id !== 'string') {
        return sendError(res, 'upi_id must be a string or null.', 400);
      }
      const trimmed = upi_id.trim();
      // Basic UPI ID format: localpart@provider
      if (trimmed && !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9]+$/.test(trimmed)) {
        return sendError(res, 'Invalid UPI ID format. Expected format: name@bank', 400);
      }
      await prisma.gym.update({
        where: { id: req.gymOwner.gym_id },
        data: { upi_id: trimmed || null },
      });
      return sendSuccess(res, { upi_id: trimmed || null }, 'UPI settings updated.');
    }
    return sendError(res, 'upi_id field is required.', 400);
  } catch (err) {
    next(err);
  }
}

async function getMyGyms(req, res, next) {
  try {
    const gymIds = req.gymOwner.gym_ids;
    const gyms = await prisma.gym.findMany({
      where: { id: { in: gymIds } },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
    return sendSuccess(res, gyms, 'Accessible gyms retrieved.');
  } catch (err) {
    next(err);
  }
}

module.exports = { getHealth, triggerSync, patchCredentials, getServices, updateServices, getSubscription, getUpiSettings, updateUpiSettings, getMyGyms };
