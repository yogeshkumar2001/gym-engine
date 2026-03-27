'use strict';

const OnboardingService = require('../services/whatsapp/OnboardingService');
const { sendSuccess, sendError } = require('../utils/response');

// E.164 format: digits only, 10–15 characters (e.g. '919876543210')
const E164_RE = /^\d{10,15}$/;

/**
 * POST /api/onboarding/whatsapp/start
 * Registers the gym's phone number under the system WABA.
 * Body: { phone_number, display_name }
 */
async function startWhatsappOnboarding(req, res, next) {
  const { phone_number, display_name } = req.body;
  const gymId = req.gymOwner.gym_id;

  if (!phone_number || !E164_RE.test(phone_number)) {
    return sendError(res, 'phone_number must be 10–15 digits in E.164 format (no + prefix).', 400);
  }

  if (!display_name || typeof display_name !== 'string' || !display_name.trim()) {
    return sendError(res, 'display_name is required.', 400);
  }

  try {
    const result = await OnboardingService.startOnboarding(gymId, phone_number);
    return sendSuccess(res, {
      verification_method: result.verification_method,
      message: 'OTP sent to phone',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/onboarding/whatsapp/verify-otp
 * Submits the OTP to Meta to verify and activate the phone number.
 * Body: { otp_code }
 */
async function verifyWhatsappOTP(req, res, next) {
  const { otp_code } = req.body;
  const gymId = req.gymOwner.gym_id;

  if (!otp_code || typeof otp_code !== 'string' || !otp_code.trim()) {
    return sendError(res, 'otp_code is required.', 400);
  }

  try {
    const result = await OnboardingService.verifyOTP(gymId, otp_code.trim());
    return sendSuccess(res, { verified: result.verified, phone_number_id: result.phone_number_id });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/onboarding/whatsapp/status
 * Returns the current WhatsApp registration status for the gym.
 * Auto-promotes to active if Meta has approved the number.
 */
async function getWhatsappStatus(req, res, next) {
  const gymId = req.gymOwner.gym_id;

  try {
    const result = await OnboardingService.checkRegistrationStatus(gymId);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

module.exports = { startWhatsappOnboarding, verifyWhatsappOTP, getWhatsappStatus };
