'use strict';

const axios = require('axios');
const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');
const { enqueue } = require('./QueueProcessor');

const GRAPH_API_VERSION = 'v22.0';

/**
 * Initiates phone number registration under WABA_ID.
 * Creates a WhatsappAccount row in 'verifying' state.
 *
 * @param {number} gymId
 * @param {string} phoneNumber  E.164 format, e.g. '919876543210'
 * @returns {Promise<{ verification_method: string, code_sent: boolean }>}
 */
async function startOnboarding(gymId, phoneNumber) {
  const wabaId = process.env.WABA_ID;
  const { decryptField } = require('../../utils/encryption');
  const TokenManager = require('./TokenManager');
  const { access_token } = await TokenManager.getActiveToken();

  // Register the phone number under WABA
  const response = await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/phone_numbers`,
    {
      cc: phoneNumber.slice(0, 2),          // country code (e.g. '91')
      phone_number: phoneNumber.slice(2),   // local number
      method: 'SMS',
    },
    { headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' } }
  );

  const verificationMethod = response.data?.method ?? 'SMS';

  // Upsert the WhatsappAccount row
  await prisma.whatsappAccount.upsert({
    where: { gym_id: gymId },
    update: {
      display_phone: phoneNumber,
      status: 'verifying',
      fallback_mode: true,
      updated_at: new Date(),
    },
    create: {
      gym_id: gymId,
      display_phone: phoneNumber,
      status: 'verifying',
      fallback_mode: true,
    },
  });

  await prisma.gym.update({
    where: { id: gymId },
    data: { whatsapp_status: 'onboarding' },
  });

  logger.info('[OnboardingService] startOnboarding', {
    gym_id: gymId,
    phone: phoneNumber,
    verification_method: verificationMethod,
  });

  return { verification_method: verificationMethod, code_sent: true };
}

/**
 * Submits the OTP to Meta to verify and activate the phone number.
 *
 * @param {number} gymId
 * @param {string} otpCode
 * @returns {Promise<{ verified: boolean, phone_number_id: string }>}
 */
async function verifyOTP(gymId, otpCode) {
  const TokenManager = require('./TokenManager');
  const { access_token } = await TokenManager.getActiveToken();

  const account = await prisma.whatsappAccount.findUnique({
    where: { gym_id: gymId },
    select: { display_phone: true },
  });

  if (!account) throw new Error('WhatsappAccount not found for gym');

  // Verify the OTP
  const verifyResponse = await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WABA_ID}/verify_code`,
    { code: otpCode, phone_number: account.display_phone },
    { headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' } }
  );

  const phoneNumberId = verifyResponse.data?.id ?? null;

  await prisma.whatsappAccount.update({
    where: { gym_id: gymId },
    data: {
      status: 'active',
      phone_number_id: phoneNumberId,
      verified_at: new Date(),
    },
  });

  logger.info('[OnboardingService] verifyOTP success', { gym_id: gymId, phone_number_id: phoneNumberId });

  return { verified: true, phone_number_id: phoneNumberId };
}

/**
 * Checks registration status and auto-switches out of fallback mode if active.
 *
 * @param {number} gymId
 * @returns {Promise<{ status: string, fallback_mode: boolean, phone_number_id: string|null }>}
 */
async function checkRegistrationStatus(gymId) {
  const account = await prisma.whatsappAccount.findUnique({
    where: { gym_id: gymId },
    select: { status: true, fallback_mode: true, phone_number_id: true, quality_rating: true },
  });

  if (!account) {
    return { status: 'not_setup', fallback_mode: true, phone_number_id: null, quality_rating: null };
  }

  // Auto-switchover: if fully active but still in fallback mode, promote
  if (account.status === 'active' && account.fallback_mode) {
    await activateGym(gymId);
    return { status: 'active', fallback_mode: false, phone_number_id: account.phone_number_id, quality_rating: account.quality_rating };
  }

  return {
    status: account.status,
    fallback_mode: account.fallback_mode,
    phone_number_id: account.phone_number_id,
    quality_rating: account.quality_rating,
  };
}

/**
 * Promotes a gym from fallback → fully active WABA sending.
 * Creates a WhatsappConfig row with defaults if absent.
 * Enqueues a welcome notification to the owner.
 *
 * @param {number} gymId
 */
async function activateGym(gymId) {
  await prisma.whatsappAccount.update({
    where: { gym_id: gymId },
    data: { fallback_mode: false },
  });

  await prisma.gym.update({
    where: { id: gymId },
    data: { whatsapp_status: 'active' },
  });

  // Create default config if not yet present
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { name: true, owner_phone: true, upi_id: true, recovery_discount_percent: true, reactivation_discount_percent: true },
  });

  const existingConfig = await prisma.whatsappConfig.findUnique({ where: { gym_id: gymId } });

  if (!existingConfig) {
    await prisma.whatsappConfig.create({
      data: {
        gym_id: gymId,
        upi_id: gym?.upi_id ?? null,
        recovery_discount_pct: gym?.recovery_discount_percent ?? 5.0,
        winback_discount_pct: gym?.reactivation_discount_percent ?? 10.0,
      },
    });
  }

  // Notify owner
  if (gym?.owner_phone) {
    await enqueue(
      gymId,
      null,
      'onboarding_complete',
      [gym.name],
      gym.owner_phone,
      { trigger_type: 'manual' }
    );
  }

  logger.info('[OnboardingService] activateGym — gym now fully active', { gym_id: gymId });
}

module.exports = { startOnboarding, verifyOTP, checkRegistrationStatus, activateGym };
