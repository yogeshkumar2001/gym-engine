'use strict';

const syncService = require('../services/sync.service');
const { sendSuccess, sendError } = require('../utils/response');
const logger = require('../config/logger');

const syncMembers = async (req, res, next) => {
  try {
    const gymId = parseInt(req.params.gymId, 10);

    if (isNaN(gymId) || gymId <= 0) {
      return sendError(res, 'Invalid gym ID.', 400);
    }

    logger.info(`Sync requested for gym ${gymId}`);

    const result = await syncService.syncGymMembers(gymId);

    if (result === null) {
      return sendError(res, 'Gym not found.', 404);
    }

    return sendSuccess(res, result, 'Sync completed successfully.');
  } catch (err) {
    // Google API errors (invalid sheet, permission denied) bubble up here
    if (err.code === 404 || (err.response && err.response.status === 404)) {
      return sendError(res, 'Google Sheet not found or not shared with service account.', 422);
    }
    if (err.code === 403 || (err.response && err.response.status === 403)) {
      return sendError(res, 'Permission denied. Share the sheet with the service account email.', 403);
    }
    next(err);
  }
};

module.exports = { syncMembers };
