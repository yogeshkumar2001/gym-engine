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

    logger.info(`Sync started for gym ${gymId}`);

    const result = await syncService.syncGymMembers(gymId);

    if (result === null) {
      return sendError(res, 'Gym not found.', 404);
    }

    logger.info(`Sync completed for gym ${gymId}: ${JSON.stringify(result)}`);
    return sendSuccess(res, result, 'Sync completed successfully.');
  } catch (err) {
    logger.error(`Sync error for gym ${req.params.gymId}: ${err.message}`, { stack: err.stack });

    const status = err.response?.status ?? err.code;

    if (status === 404) {
      return sendError(res, 'Google Sheet not found or not shared with the service account.', 422);
    }
    if (status === 403) {
      return sendError(res, 'Permission denied. Share the sheet with the service account email.', 403);
    }
    if (status === 400) {
      return sendError(res, 'Invalid Google Sheet ID.', 422);
    }

    next(err);
  }
};

module.exports = { syncMembers };
