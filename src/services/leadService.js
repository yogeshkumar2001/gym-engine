'use strict';

const prisma = require('../lib/prisma');

const VALID_STAGES = ['walk_in', 'trial', 'converted', 'lost'];
const VALID_SOURCES = ['walk_in', 'referral', 'instagram', 'google'];

/**
 * Creates a new Lead for a gym.
 *
 * @param {number} gymId
 * @param {{ name: string, phone: string, source?: string }} data
 * @returns {Promise<object>} The created lead
 */
async function createLead(gymId, data) {
  const { name, phone, source } = data;

  if (source && !VALID_SOURCES.includes(source)) {
    const err = new Error(`Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}`);
    err.status = 400;
    throw err;
  }

  return prisma.lead.create({
    data: {
      gym_id: gymId,
      name: name.trim(),
      phone: phone.trim(),
      source: source || null,
      stage: 'walk_in',
    },
  });
}

/**
 * Returns paginated leads for a gym, optionally filtered by stage.
 *
 * @param {number} gymId
 * @param {{ stage?: string, limit?: number, offset?: number }} opts
 * @returns {Promise<{ leads: Array, total: number }>}
 */
async function getLeads(gymId, opts = {}) {
  const { stage, limit = 50, offset = 0 } = opts;

  const where = { gym_id: gymId };
  if (stage) where.stage = stage;

  const [leads, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: Math.min(limit, 100),
      skip: offset,
    }),
    prisma.lead.count({ where }),
  ]);

  return { leads, total };
}

/**
 * Advances a lead's stage.
 * Valid transitions: walk_in → trial, walk_in → converted, walk_in → lost,
 *                    trial → converted, trial → lost
 *
 * Extra data per stage:
 *   - trial:     { trial_start, trial_end }
 *   - converted: {}  (converted_at auto-set)
 *   - lost:      { lost_reason }
 *
 * @param {number} gymId
 * @param {number} leadId
 * @param {string} newStage
 * @param {object} [extra]
 * @returns {Promise<object>} Updated lead
 * @throws {{ status: 400|404 }}
 */
async function updateLeadStage(gymId, leadId, newStage, extra = {}) {
  if (!VALID_STAGES.includes(newStage)) {
    const err = new Error(`Invalid stage. Must be one of: ${VALID_STAGES.join(', ')}`);
    err.status = 400;
    throw err;
  }

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, gym_id: true, stage: true },
  });

  if (!lead || lead.gym_id !== gymId) {
    const err = new Error('Lead not found.');
    err.status = 404;
    throw err;
  }

  // converted and lost are terminal — no further transitions allowed
  if (lead.stage === 'converted' || lead.stage === 'lost') {
    const err = new Error(`Lead is already '${lead.stage}' and cannot be moved to another stage.`);
    err.status = 400;
    throw err;
  }

  // Prevent moving backwards (trial → walk_in)
  const stageOrder = { walk_in: 0, trial: 1, converted: 2, lost: 2 };
  if (stageOrder[newStage] < stageOrder[lead.stage]) {
    const err = new Error(`Cannot move lead from '${lead.stage}' back to '${newStage}'.`);
    err.status = 400;
    throw err;
  }

  const updateData = { stage: newStage };

  if (newStage === 'trial') {
    if (extra.trial_start) updateData.trial_start = new Date(extra.trial_start);
    if (extra.trial_end)   updateData.trial_end   = new Date(extra.trial_end);
  }

  if (newStage === 'converted') {
    updateData.converted_at = new Date();
  }

  if (newStage === 'lost' && extra.lost_reason) {
    updateData.lost_reason = extra.lost_reason;
  }

  return prisma.lead.update({
    where: { id: leadId },
    data: updateData,
  });
}

/**
 * Returns funnel statistics for a gym.
 * Counts per stage + conversion rate (converted / total).
 *
 * @param {number} gymId
 * @returns {Promise<object>}
 */
async function getFunnelStats(gymId) {
  const stageGroups = await prisma.lead.groupBy({
    by: ['stage'],
    where: { gym_id: gymId },
    _count: { id: true },
  });

  const counts = { walk_in: 0, trial: 0, converted: 0, lost: 0 };
  for (const row of stageGroups) counts[row.stage] = row._count.id;

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const conversionRate = total > 0 ? Math.round((counts.converted / total) * 1000) / 1000 : 0;
  const trialConversionRate = counts.trial + counts.converted > 0
    ? Math.round((counts.converted / (counts.trial + counts.converted)) * 1000) / 1000
    : 0;

  return {
    total_leads: total,
    by_stage: counts,
    conversion_rate: conversionRate,
    trial_to_conversion_rate: trialConversionRate,
  };
}

module.exports = { createLead, getLeads, updateLeadStage, getFunnelStats };
