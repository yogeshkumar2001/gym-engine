'use strict';

const axios = require('axios');
const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');
const { decryptField, encryptField } = require('../../utils/encryption');

const GRAPH_API_VERSION = 'v22.0';

/**
 * Returns the active system token (decrypted).
 * @returns {Promise<{ access_token: string, expires_at: Date, status: string }>}
 * @throws {Error} 'NO_ACTIVE_TOKEN' if none found
 */
async function getActiveToken() {
  const row = await prisma.systemToken.findFirst({
    where: { token_type: 'waba_system_user', status: { in: ['active', 'expiring_soon'] } },
    orderBy: { created_at: 'desc' },
  });

  if (!row) {
    throw new Error('NO_ACTIVE_TOKEN');
  }

  return {
    access_token: decryptField(row.access_token),
    expires_at: row.expires_at,
    status: row.status,
  };
}

/**
 * Verifies the active token against Meta's /me endpoint.
 * Sets status to 'expiring_soon' if < 7 days remain, 'expired' on 401.
 */
async function healthCheck() {
  const row = await prisma.systemToken.findFirst({
    where: { token_type: 'waba_system_user', status: { in: ['active', 'expiring_soon'] } },
    orderBy: { created_at: 'desc' },
  });

  if (!row) {
    logger.error('[TokenManager] healthCheck: no active system token found');
    return;
  }

  const token = decryptField(row.access_token);

  try {
    await axios.get(`https://graph.facebook.com/${GRAPH_API_VERSION}/me`, {
      params: { access_token: token },
    });

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const isExpiringSoon = row.expires_at - Date.now() < sevenDaysMs;

    await prisma.systemToken.update({
      where: { id: row.id },
      data: {
        last_verified: new Date(),
        status: isExpiringSoon ? 'expiring_soon' : 'active',
      },
    });

    if (isExpiringSoon) {
      logger.warn('[TokenManager] System token expiring soon', { expires_at: row.expires_at });
      await alertFounder(`System WhatsApp token expires at ${row.expires_at.toISOString()}. Please rotate.`);
    }
  } catch (err) {
    const statusCode = err.response?.status;
    if (statusCode === 401) {
      await prisma.systemToken.update({
        where: { id: row.id },
        data: { status: 'expired' },
      });
      logger.error('[TokenManager] System token is expired (401)', { token_id: row.id });
      await alertFounder('System WhatsApp token has EXPIRED. Renewal engine is down. Rotate immediately.');
      throw new Error('TOKEN_EXPIRED');
    }
    logger.error('[TokenManager] healthCheck failed', { status_code: statusCode, error_message: err.message });
    throw err;
  }
}

/**
 * Sends a plain-text WhatsApp alert to the founder's number.
 * Never throws — alerting failure must not crash the caller.
 * @param {string} message
 */
async function alertFounder(message) {
  const founderPhone = process.env.FOUNDER_WHATSAPP_NUMBER;
  if (!founderPhone) {
    logger.error('[TokenManager] FOUNDER_WHATSAPP_NUMBER not set — cannot send alert');
    return;
  }

  try {
    const { access_token } = await getActiveToken();
    const wabaId = process.env.WABA_ID;

    // Use the first active phone_number_id we can find for the system
    const account = await prisma.whatsappAccount.findFirst({
      where: { status: 'active' },
      select: { phone_number_id: true },
    });

    if (!account?.phone_number_id) {
      logger.error('[TokenManager] alertFounder: no active phone_number_id available');
      return;
    }

    await axios.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${account.phone_number_id}/messages`,
      {
        messaging_product: 'whatsapp',
        to: founderPhone,
        type: 'text',
        text: { body: `[GymEngine Alert] ${message}` },
      },
      { headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    logger.error('[TokenManager] alertFounder failed — swallowing', { error_message: err.message });
  }
}

module.exports = { getActiveToken, healthCheck, alertFounder };
