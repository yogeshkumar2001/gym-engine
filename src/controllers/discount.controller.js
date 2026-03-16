'use strict';

const prisma = require('../lib/prisma');
const { sendSuccess, sendError } = require('../utils/response');

const MIN_DISCOUNT = 0;
const MAX_DISCOUNT = 50;

function validateDiscountPercent(value, fieldName) {
  if (value === undefined) return null; // optional — not provided
  const num = Number(value);
  if (!Number.isFinite(num) || num < MIN_DISCOUNT || num > MAX_DISCOUNT) {
    return `${fieldName} must be a number between ${MIN_DISCOUNT} and ${MAX_DISCOUNT}.`;
  }
  return null;
}

/**
 * PATCH /owner/settings/discounts
 * Body: { recovery_discount_percent?, reactivation_discount_percent? }
 * At least one field required.
 */
async function updateDiscounts(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const { recovery_discount_percent, reactivation_discount_percent } = req.body;

  if (recovery_discount_percent === undefined && reactivation_discount_percent === undefined) {
    return sendError(res, 'Provide at least one of recovery_discount_percent or reactivation_discount_percent.', 400);
  }

  const errors = [
    validateDiscountPercent(recovery_discount_percent,    'recovery_discount_percent'),
    validateDiscountPercent(reactivation_discount_percent, 'reactivation_discount_percent'),
  ].filter(Boolean);

  if (errors.length > 0) return sendError(res, errors[0], 400);

  const data = {};
  if (recovery_discount_percent    !== undefined) data.recovery_discount_percent    = Number(recovery_discount_percent);
  if (reactivation_discount_percent !== undefined) data.reactivation_discount_percent = Number(reactivation_discount_percent);

  try {
    const gym = await prisma.gym.update({ where: { id: gymId }, data,
      select: { id: true, recovery_discount_percent: true, reactivation_discount_percent: true },
    });
    return sendSuccess(res, gym, 'Discount settings updated.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /owner/settings/discounts
 */
async function getDiscounts(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  try {
    const gym = await prisma.gym.findUnique({
      where: { id: gymId },
      select: { recovery_discount_percent: true, reactivation_discount_percent: true },
    });
    if (!gym) return sendError(res, 'Gym not found.', 404);
    return sendSuccess(res, gym, 'Discount settings retrieved.');
  } catch (err) {
    next(err);
  }
}

module.exports = { updateDiscounts, getDiscounts };
