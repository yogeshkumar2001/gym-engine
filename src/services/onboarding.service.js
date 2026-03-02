'use strict';

const axios = require('axios');
const prisma = require('../lib/prisma');
const { encrypt } = require('../utils/encryption');
const { getSheetRows } = require('./googleSheetService');

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
      google_sheet_id, // stored plaintext
      status: 'active',
      onboarding_token: null,
      last_health_check_at: new Date(),
      last_error_message: null,
    },
  });

  return { success: true };
}

module.exports = { submitCredentials };
