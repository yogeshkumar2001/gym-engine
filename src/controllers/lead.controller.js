'use strict';

const leadService = require('../services/leadService');
const { sendSuccess, sendError } = require('../utils/response');

/**
 * POST /owner/leads
 * Body: { name, phone, source? }
 */
async function createLead(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const { name, phone, source } = req.body;

  if (!name || !phone) {
    return sendError(res, 'name and phone are required.', 400);
  }

  try {
    const lead = await leadService.createLead(gymId, { name, phone, source });
    return sendSuccess(res, lead, 'Lead created.', 201);
  } catch (err) {
    if (err.status) return sendError(res, err.message, err.status);
    next(err);
  }
}

/**
 * GET /owner/leads
 * Query: stage?, limit?, offset?
 */
async function getLeads(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const { stage, limit, offset } = req.query;

  try {
    const result = await leadService.getLeads(gymId, {
      stage: stage || undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return sendSuccess(res, result, 'Leads retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /owner/leads/:leadId/stage
 * Body: { stage, trial_start?, trial_end?, lost_reason? }
 */
async function updateLeadStage(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const leadId = parseInt(req.params.leadId, 10);

  if (!Number.isInteger(leadId) || leadId <= 0) {
    return sendError(res, 'Invalid leadId.', 400);
  }

  const { stage, trial_start, trial_end, lost_reason } = req.body;

  if (!stage) {
    return sendError(res, 'stage is required.', 400);
  }

  try {
    const lead = await leadService.updateLeadStage(gymId, leadId, stage, {
      trial_start,
      trial_end,
      lost_reason,
    });
    return sendSuccess(res, lead, 'Lead stage updated.');
  } catch (err) {
    if (err.status) return sendError(res, err.message, err.status);
    next(err);
  }
}

/**
 * GET /owner/leads/funnel
 * Returns funnel stats for the authenticated owner's gym.
 */
async function getFunnelStats(req, res, next) {
  const gymId = req.gymOwner.gym_id;

  try {
    const stats = await leadService.getFunnelStats(gymId);
    return sendSuccess(res, stats, 'Funnel stats retrieved.');
  } catch (err) {
    next(err);
  }
}

module.exports = { createLead, getLeads, updateLeadStage, getFunnelStats };
