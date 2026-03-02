'use strict';

const adminService = require('../services/admin.service');
const { sendSuccess, sendError } = require('../utils/response');

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

module.exports = { globalHealth, gymDeepHealth };
