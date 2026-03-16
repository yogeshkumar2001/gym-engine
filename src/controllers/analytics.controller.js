'use strict';

const forecastService = require('../services/forecastService');
const analyticsService = require('../services/analyticsService');
const cohortService = require('../services/cohortService');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * Resolve gymId from either:
 *   - req.params.gymId (admin routes — integer path param)
 *   - req.gymOwner.gym_id (owner routes — set by verifyJWT)
 */
function resolveGymId(req) {
  if (req.gymOwner) return req.gymOwner.gym_id;
  return parseInt(req.params.gymId, 10);
}

/**
 * GET /admin/gym/:gymId/forecast
 * GET /owner/analytics/forecast
 *
 * Query params:
 *   days (optional, 1–365, default 30)
 */
async function revenueForecast(req, res, next) {
  const gymId = resolveGymId(req);
  if (!Number.isInteger(gymId) || gymId <= 0) {
    return sendError(res, 'Invalid gymId.', 400);
  }

  const days = parseInt(req.query.days, 10) || 30;
  if (days < 1 || days > 365) {
    return sendError(res, 'days query param must be between 1 and 365.', 400);
  }

  try {
    const data = await forecastService.getForecast(gymId, days);
    return sendSuccess(res, data, 'Revenue forecast retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/gym/:gymId/ltv-report
 * GET /owner/analytics/ltv
 */
async function ltvReport(req, res, next) {
  const gymId = resolveGymId(req);
  if (!Number.isInteger(gymId) || gymId <= 0) {
    return sendError(res, 'Invalid gymId.', 400);
  }

  try {
    const data = await analyticsService.getGymLTVReport(gymId);
    return sendSuccess(res, data, 'LTV report retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/gym/:gymId/plan-report
 * GET /owner/analytics/plans
 */
async function planReport(req, res, next) {
  const gymId = resolveGymId(req);
  if (!Number.isInteger(gymId) || gymId <= 0) {
    return sendError(res, 'Invalid gymId.', 400);
  }

  try {
    const data = await analyticsService.getPlanProfitability(gymId);
    return sendSuccess(res, data, 'Plan profitability report retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/gym/:gymId/cohorts
 * GET /owner/analytics/cohorts
 */
async function cohortReport(req, res, next) {
  const gymId = resolveGymId(req);
  if (!Number.isInteger(gymId) || gymId <= 0) {
    return sendError(res, 'Invalid gymId.', 400);
  }
  try {
    const data = await cohortService.getMemberCohorts(gymId);
    return sendSuccess(res, data, 'Cohort report retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/gym/:gymId/retention
 * GET /owner/analytics/retention
 */
async function retentionCurve(req, res, next) {
  const gymId = resolveGymId(req);
  if (!Number.isInteger(gymId) || gymId <= 0) {
    return sendError(res, 'Invalid gymId.', 400);
  }
  try {
    const data = await cohortService.getRetentionCurve(gymId);
    return sendSuccess(res, data, 'Retention curve retrieved.');
  } catch (err) {
    next(err);
  }
}

module.exports = { revenueForecast, ltvReport, planReport, cohortReport, retentionCurve };
