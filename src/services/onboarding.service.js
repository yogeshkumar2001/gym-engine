'use strict';

const axios = require('axios');
const prisma = require('../lib/prisma');
const { encrypt } = require('../utils/encryption');
const { getSheetRows } = require('./googleSheetService');
const { syncGymMembers } = require('./sync.service');
const logger = require('../config/logger');

async function submitCredentials({
  gym_id,
  onboarding_token,
  razorpay_key_id,
  razorpay_key_secret,
  razorpay_webhook_secret,
  whatsapp_phone_number_id,
  whatsapp_access_token,
  google_sheet_id,
}) {
  // 1. Fetch gym and verify token
  const gym = await prisma.gym.findUnique({ where: { id: gym_id } });

  if (!gym) {
    const err = new Error('Gym not found.');
    err.status = 404;
    throw err;
  }

  if (gym.onboarding_token !== onboarding_token) {
    const err = new Error('Invalid or expired onboarding token.');
    err.status = 403;
    throw err;
  }

  // 2. Block re-submission for already-active or suspended gyms
  if (gym.status === 'active' || gym.status === 'suspended') {
    const err = new Error(`Gym is already ${gym.status}. Credentials cannot be re-submitted.`);
    err.status = 409;
    throw err;
  }

  // 3. Validate all 3 integrations in parallel
  const errors = [];

  const [rzpResult, waResult, gsResult] = await Promise.allSettled([
    axios.get('https://api.razorpay.com/v1/payments?count=1', {
      auth: { username: razorpay_key_id, password: razorpay_key_secret },
    }),
    axios.get(`https://graph.facebook.com/v22.0/${whatsapp_phone_number_id}`, {
      headers: { Authorization: `Bearer ${whatsapp_access_token}` },
    }),
    getSheetRows(google_sheet_id),
  ]);

  if (rzpResult.status === 'rejected') {
    errors.push({
      field: 'razorpay',
      message: rzpResult.reason?.response?.data?.error?.description || rzpResult.reason?.message || 'Razorpay validation failed.',
    });
  }

  if (waResult.status === 'rejected') {
    errors.push({
      field: 'whatsapp',
      message: waResult.reason?.response?.data?.error?.message || waResult.reason?.message || 'WhatsApp validation failed.',
    });
  }

  if (gsResult.status === 'rejected') {
    errors.push({
      field: 'google_sheet',
      message: gsResult.reason?.message || 'Google Sheet validation failed.',
    });
  }

  // 4. On any failure — record error and return
  if (errors.length > 0) {
    await prisma.gym.update({
      where: { id: gym_id },
      data: {
        status: 'error',
        last_error_message: errors.map(e => `[${e.field}] ${e.message}`).join('; '),
        last_error_at: new Date(),
      },
    });
    return { success: false, errors };
  }

  // 5. All passed — encrypt credentials and activate
  await prisma.gym.update({
    where: { id: gym_id },
    data: {
      razorpay_key_id: encrypt(razorpay_key_id),
      razorpay_key_secret: encrypt(razorpay_key_secret),
      razorpay_webhook_secret: encrypt(razorpay_webhook_secret),
      whatsapp_phone_number_id: encrypt(whatsapp_phone_number_id),
      whatsapp_access_token: encrypt(whatsapp_access_token),
      google_sheet_id: encrypt(google_sheet_id),
      status: 'active',
      onboarding_token: null,
      last_health_check_at: new Date(),
      last_error_message: null,
    },
  });

  // 6. Kick off initial member sync in background (non-blocking)
  setImmediate(() => {
    syncGymMembers(gym_id).catch((err) =>
      logger.error({ err, gym_id }, 'Initial member sync failed after onboarding')
    );
  });

  return { success: true };
}

// Partial credential update — only updates fields that are provided.
async function updateCredentials(gymId, fields) {
  const updateData = {};
  if (fields.razorpay_key_id)          updateData.razorpay_key_id          = encrypt(fields.razorpay_key_id);
  if (fields.razorpay_key_secret)      updateData.razorpay_key_secret      = encrypt(fields.razorpay_key_secret);
  if (fields.razorpay_webhook_secret)  updateData.razorpay_webhook_secret  = encrypt(fields.razorpay_webhook_secret);
  if (fields.whatsapp_phone_number_id) updateData.whatsapp_phone_number_id = encrypt(fields.whatsapp_phone_number_id);
  if (fields.whatsapp_access_token)    updateData.whatsapp_access_token    = encrypt(fields.whatsapp_access_token);
  if (fields.google_sheet_id)          updateData.google_sheet_id          = encrypt(fields.google_sheet_id);

  if (Object.keys(updateData).length === 0) {
    const err = new Error('No credential fields provided.');
    err.status = 400;
    throw err;
  }

  // Reset validity flags for updated integrations so the cron re-validates them
  if (updateData.razorpay_key_id || updateData.razorpay_key_secret)
    updateData.razorpay_valid = null;
  if (updateData.whatsapp_phone_number_id || updateData.whatsapp_access_token)
    updateData.whatsapp_valid = null;
  if (updateData.google_sheet_id)
    updateData.sheet_valid = null;

  await prisma.gym.update({ where: { id: gymId }, data: updateData });
  return { updated: Object.keys(fields).filter((k) => fields[k]) };
}

module.exports = { submitCredentials, updateCredentials };
