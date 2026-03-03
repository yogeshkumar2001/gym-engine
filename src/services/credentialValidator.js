'use strict';

const axios = require('axios');
const { getSheetRows } = require('./googleSheetService');

// Shared timeout (ms) for every outbound validation call.
// Long enough to survive a slow upstream; short enough not to stall the cron.
const VALIDATION_TIMEOUT_MS = 10_000;

/**
 * Validates Razorpay credentials with a lightweight read-only call.
 *
 * Uses GET /v1/payment_links?count=1 — no side effects, no charges.
 * A 401 / 400 response means the key pair is invalid or revoked.
 *
 * @param {{ razorpay_key_id: string, razorpay_key_secret: string }} gym
 * @returns {Promise<{ valid: boolean, error: string|null }>}
 */
async function validateRazorpay({ razorpay_key_id, razorpay_key_secret }) {
  try {
    await axios.get('https://api.razorpay.com/v1/payment_links?count=1', {
      auth: { username: razorpay_key_id, password: razorpay_key_secret },
      timeout: VALIDATION_TIMEOUT_MS,
    });
    return { valid: true, error: null };
  } catch (err) {
    const error =
      err.response?.data?.error?.description ||
      err.response?.data?.error?.code ||
      err.message ||
      'Razorpay validation failed.';
    return { valid: false, error };
  }
}

/**
 * Validates WhatsApp Cloud API credentials with a lightweight read-only call.
 *
 * Uses GET /v22.0/{phone_number_id} — returns phone number metadata.
 * No message is sent. A 190 (invalid token) or 100 (no permission) OAuthException
 * indicates the token is expired or the number ID is wrong.
 *
 * @param {{ whatsapp_phone_number_id: string, whatsapp_access_token: string }} gym
 * @returns {Promise<{ valid: boolean, error: string|null }>}
 */
async function validateWhatsapp({ whatsapp_phone_number_id, whatsapp_access_token }) {
  try {
    await axios.get(
      `https://graph.facebook.com/v22.0/${whatsapp_phone_number_id}`,
      {
        headers: { Authorization: `Bearer ${whatsapp_access_token}` },
        timeout: VALIDATION_TIMEOUT_MS,
      }
    );
    return { valid: true, error: null };
  } catch (err) {
    const error =
      err.response?.data?.error?.message ||
      err.message ||
      'WhatsApp validation failed.';
    return { valid: false, error };
  }
}

/**
 * Validates Google Sheet access by attempting to read the first row.
 *
 * Uses the service account already configured in googleSheetService.
 * Permission errors (403), sheet-not-found (404), or any exception
 * indicate the service account has lost access or the sheet ID is wrong.
 *
 * @param {{ google_sheet_id: string }} gym
 * @returns {Promise<{ valid: boolean, error: string|null }>}
 */
async function validateGoogleSheet({ google_sheet_id }) {
  try {
    await getSheetRows(google_sheet_id);
    return { valid: true, error: null };
  } catch (err) {
    return { valid: false, error: err.message || 'Google Sheet validation failed.' };
  }
}

module.exports = { validateRazorpay, validateWhatsapp, validateGoogleSheet };
