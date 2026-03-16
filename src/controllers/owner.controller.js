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

module.exports = { getHealth, triggerSync, patchCredentials, getServices, updateServices };
