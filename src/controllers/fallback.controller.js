'use strict';

const { generateDailyDigest, markFallbackSent } = require('../services/whatsapp/FallbackGenerator');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * GET /owner/fallback/today
 * Returns today's queued fallback digest for the gym.
 */
async function getFallbackToday(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  try {
    const result = await generateDailyDigest(gymId);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /owner/fallback/mark-sent
 * Marks all of today's queued fallback messages as sent.
 */
async function markFallbackSentHandler(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  try {
    await markFallbackSent(gymId);
    return sendSuccess(res, null, 'Messages marked as sent.');
  } catch (err) {
    next(err);
  }
}

module.exports = { getFallbackToday, markFallbackSentHandler };
