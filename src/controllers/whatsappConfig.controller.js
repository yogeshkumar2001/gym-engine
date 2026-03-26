'use strict';

const prisma = require('../lib/prisma');
const { sendSuccess, sendError } = require('../utils/response');

// ─── Validation helpers ───────────────────────────────────────────────────────

const VALID_PAYMENT_MODES = ['razorpay', 'upi_only', 'cash_only', 'razorpay_upi'];
const VALID_LANGUAGES      = ['en', 'hi'];
const HHMM_RE              = /^\d{2}:\d{2}$/;

function validateDiscount(value, field) {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 50)
    return `${field} must be a number between 0 and 50.`;
  return null;
}

function validateHHMM(value, field) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !HHMM_RE.test(value))
    return `${field} must be in HH:MM format.`;
  return null;
}

function validateReminderDays(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 5)
    return 'reminder_days_before must be an array of 1–5 elements.';
  for (const d of value) {
    if (!Number.isInteger(d) || d < 1 || d > 14)
      return 'reminder_days_before values must be integers between 1 and 14.';
  }
  return null;
}

// ─── Shared upsert helper ─────────────────────────────────────────────────────

async function upsertConfig(gymId, data) {
  return prisma.whatsappConfig.upsert({
    where:  { gym_id: gymId },
    create: { gym_id: gymId, ...data },
    update: data,
  });
}

// ─── WhatsApp Basics  GET /owner/settings/whatsapp ───────────────────────────

async function getWhatsappConfig(req, res, next) {
  try {
    const config = await prisma.whatsappConfig.findUnique({
      where:  { gym_id: req.gymOwner.gym_id },
      select: { payment_mode: true, upi_id: true, language_pref: true, razorpay_enabled: true },
    });
    return sendSuccess(res, config ?? {}, 'WhatsApp config retrieved.');
  } catch (err) { next(err); }
}

async function updateWhatsappConfig(req, res, next) {
  const { payment_mode, upi_id, language_pref, razorpay_enabled } = req.body;

  const errors = [
    payment_mode  !== undefined && !VALID_PAYMENT_MODES.includes(payment_mode)
      ? `payment_mode must be one of: ${VALID_PAYMENT_MODES.join(', ')}.` : null,
    language_pref !== undefined && !VALID_LANGUAGES.includes(language_pref)
      ? `language_pref must be one of: ${VALID_LANGUAGES.join(', ')}.` : null,
  ].filter(Boolean);

  if (errors.length > 0) return sendError(res, errors[0], 400);

  const data = {};
  if (payment_mode     !== undefined) data.payment_mode     = payment_mode;
  if (upi_id           !== undefined) data.upi_id           = upi_id ?? null;
  if (language_pref    !== undefined) data.language_pref    = language_pref;
  if (razorpay_enabled !== undefined) data.razorpay_enabled = Boolean(razorpay_enabled);

  if (Object.keys(data).length === 0)
    return sendError(res, 'Provide at least one field to update.', 400);

  try {
    const config = await upsertConfig(req.gymOwner.gym_id, data);
    return sendSuccess(res, config, 'WhatsApp config updated.');
  } catch (err) { next(err); }
}

// ─── Recovery  GET /owner/settings/recovery ──────────────────────────────────

async function getRecoveryConfig(req, res, next) {
  try {
    const config = await prisma.whatsappConfig.findUnique({
      where:  { gym_id: req.gymOwner.gym_id },
      select: {
        recovery_enabled:      true,
        recovery_discount_pct: true,
        recovery_start_day:    true,
        recovery_sequence:     true,
      },
    });
    return sendSuccess(res, config ?? {}, 'Recovery config retrieved.');
  } catch (err) { next(err); }
}

async function updateRecoveryConfig(req, res, next) {
  const { recovery_enabled, recovery_discount_pct, recovery_start_day } = req.body;

  const errors = [
    validateDiscount(recovery_discount_pct, 'recovery_discount_pct'),
    recovery_start_day !== undefined && (!Number.isInteger(recovery_start_day) || recovery_start_day < 0)
      ? 'recovery_start_day must be a non-negative integer.' : null,
  ].filter(Boolean);

  if (errors.length > 0) return sendError(res, errors[0], 400);

  const data = {};
  if (recovery_enabled      !== undefined) data.recovery_enabled      = Boolean(recovery_enabled);
  if (recovery_discount_pct !== undefined) data.recovery_discount_pct = Number(recovery_discount_pct);
  if (recovery_start_day    !== undefined) data.recovery_start_day    = recovery_start_day;

  if (Object.keys(data).length === 0)
    return sendError(res, 'Provide at least one field to update.', 400);

  try {
    const config = await upsertConfig(req.gymOwner.gym_id, data);
    return sendSuccess(res, config, 'Recovery config updated.');
  } catch (err) { next(err); }
}

// ─── Win-back  GET /owner/settings/winback ───────────────────────────────────

async function getWinbackConfig(req, res, next) {
  try {
    const config = await prisma.whatsappConfig.findUnique({
      where:  { gym_id: req.gymOwner.gym_id },
      select: {
        winback_enabled:      true,
        winback_delay_days:   true,
        winback_discount_pct: true,
        winback_max_attempts: true,
      },
    });
    return sendSuccess(res, config ?? {}, 'Win-back config retrieved.');
  } catch (err) { next(err); }
}

async function updateWinbackConfig(req, res, next) {
  const { winback_enabled, winback_delay_days, winback_discount_pct, winback_max_attempts } = req.body;

  const errors = [
    validateDiscount(winback_discount_pct, 'winback_discount_pct'),
    winback_delay_days !== undefined && (!Number.isInteger(winback_delay_days) || winback_delay_days < 1)
      ? 'winback_delay_days must be a positive integer.' : null,
    winback_max_attempts !== undefined && (!Number.isInteger(winback_max_attempts) || winback_max_attempts < 1)
      ? 'winback_max_attempts must be a positive integer.' : null,
  ].filter(Boolean);

  if (errors.length > 0) return sendError(res, errors[0], 400);

  const data = {};
  if (winback_enabled      !== undefined) data.winback_enabled      = Boolean(winback_enabled);
  if (winback_delay_days   !== undefined) data.winback_delay_days   = winback_delay_days;
  if (winback_discount_pct !== undefined) data.winback_discount_pct = Number(winback_discount_pct);
  if (winback_max_attempts !== undefined) data.winback_max_attempts = winback_max_attempts;

  if (Object.keys(data).length === 0)
    return sendError(res, 'Provide at least one field to update.', 400);

  try {
    const config = await upsertConfig(req.gymOwner.gym_id, data);
    return sendSuccess(res, config, 'Win-back config updated.');
  } catch (err) { next(err); }
}

// ─── Notifications  GET /owner/settings/notifications ────────────────────────

async function getNotificationConfig(req, res, next) {
  try {
    const config = await prisma.whatsappConfig.findUnique({
      where:  { gym_id: req.gymOwner.gym_id },
      select: {
        notify_on_payment:    true,
        notify_on_new_member: true,
        daily_summary_enabled:true,
        summary_send_time:    true,
        reminder_send_time:   true,
        reminder_days_before: true,
        quiet_start:          true,
        quiet_end:            true,
      },
    });
    return sendSuccess(res, config ?? {}, 'Notification config retrieved.');
  } catch (err) { next(err); }
}

async function updateNotificationConfig(req, res, next) {
  const {
    notify_on_payment, notify_on_new_member, daily_summary_enabled,
    summary_send_time, reminder_send_time, reminder_days_before,
    quiet_start, quiet_end,
  } = req.body;

  const errors = [
    validateHHMM(summary_send_time,  'summary_send_time'),
    validateHHMM(reminder_send_time, 'reminder_send_time'),
    validateHHMM(quiet_start,        'quiet_start'),
    validateHHMM(quiet_end,          'quiet_end'),
    validateReminderDays(reminder_days_before),
  ].filter(Boolean);

  if (errors.length > 0) return sendError(res, errors[0], 400);

  const data = {};
  if (notify_on_payment     !== undefined) data.notify_on_payment     = Boolean(notify_on_payment);
  if (notify_on_new_member  !== undefined) data.notify_on_new_member  = Boolean(notify_on_new_member);
  if (daily_summary_enabled !== undefined) data.daily_summary_enabled = Boolean(daily_summary_enabled);
  if (summary_send_time     !== undefined) data.summary_send_time     = summary_send_time;
  if (reminder_send_time    !== undefined) data.reminder_send_time    = reminder_send_time;
  if (reminder_days_before  !== undefined) data.reminder_days_before  = reminder_days_before;
  if (quiet_start           !== undefined) data.quiet_start           = quiet_start;
  if (quiet_end             !== undefined) data.quiet_end             = quiet_end;

  if (Object.keys(data).length === 0)
    return sendError(res, 'Provide at least one field to update.', 400);

  try {
    const config = await upsertConfig(req.gymOwner.gym_id, data);
    return sendSuccess(res, config, 'Notification config updated.');
  } catch (err) { next(err); }
}

module.exports = {
  getWhatsappConfig,    updateWhatsappConfig,
  getRecoveryConfig,    updateRecoveryConfig,
  getWinbackConfig,     updateWinbackConfig,
  getNotificationConfig, updateNotificationConfig,
};
