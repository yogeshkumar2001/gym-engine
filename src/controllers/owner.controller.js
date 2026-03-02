'use strict';

const healthService = require('../services/health.service');
const { sendSuccess } = require('../utils/response');

async function getHealth(req, res, next) {
  try {
    const health = await healthService.getGymHealth(req.gymOwner.gym_id);
    return sendSuccess(res, health, 'Gym health retrieved.');
  } catch (err) {
    next(err);
  }
}

module.exports = { getHealth };
