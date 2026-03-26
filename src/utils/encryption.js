'use strict';

const crypto = require('crypto');

const KEY_HEX = process.env.MASTER_ENCRYPTION_KEY;

if (!KEY_HEX || !/^[0-9a-fA-F]{64}$/.test(KEY_HEX)) {
  throw new Error(
    'MASTER_ENCRYPTION_KEY must be set to exactly 64 hex characters. ' +
    'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}

const KEY = Buffer.from(KEY_HEX, 'hex');

const CREDENTIAL_FIELDS = [
  'razorpay_key_id',
  'razorpay_key_secret',
  'razorpay_webhook_secret',
  'whatsapp_phone_number_id',
  'whatsapp_access_token',
  'google_sheet_id',   // added — existing plaintext values are handled by decrypt()'s backward-compat check
  'access_token',      // SystemToken
  'refresh_token',     // SystemToken
];

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * @param {string} plaintext
 * @returns {string} `enc:<ivHex>:<tagHex>:<ciphertextHex>`
 */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a value encrypted by `encrypt()`.
 * If the value does not start with `enc:`, returns it as-is (backward compat).
 * @param {string} value
 * @returns {string}
 */
function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:')) {
    return value;
  }
  const parts = value.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted value format.');
  }
  const iv = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  const ciphertext = Buffer.from(parts[3], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
}

/**
 * Decrypts the 5 credential fields on a gym object in-place.
 * Skips any field that is undefined or null.
 * @param {object} gym
 * @returns {object} The same gym object (mutated)
 */
function decryptGymCredentials(gym) {
  for (const field of CREDENTIAL_FIELDS) {
    if (gym[field] != null) {
      gym[field] = decrypt(gym[field]);
    }
  }
  return gym;
}

const encryptField = encrypt;
const decryptField = decrypt;

module.exports = { encrypt, decrypt, encryptField, decryptField, decryptGymCredentials, CREDENTIAL_FIELDS };
