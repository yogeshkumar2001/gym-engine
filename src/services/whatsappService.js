'use strict';

const axios = require('axios');
const logger = require('../config/logger');

const GRAPH_API_VERSION = 'v22.0';
const TEMPLATE_NAME = 'gym_daily_summary';
const SUMMARY_TEMPLATE_NAME = 'gym_daily_summary';

/**
 * Sends a WhatsApp renewal reminder via Meta Cloud API using the
 * "renewal_reminder" message template.
 *
 * Template body parameters (positional):
 *   {{1}} — member.name
 *   {{2}} — renewal.razorpay_short_url
 *
 * @param {{ id: number, whatsapp_phone_number_id: string, whatsapp_access_token: string }} gym
 * @param {{ id: number, razorpay_short_url: string }} renewal
 * @param {{ id: number, name: string, phone: string }} member
 * @returns {Promise<{ messageId: string|null, status: string }>}
 * @throws Will throw if the Meta API returns a non-2xx response.
 */
async function sendRenewalReminder(gym, renewal, member) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${gym.whatsapp_phone_number_id}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to: member.phone,
    type: 'template',
    template: {
      name: TEMPLATE_NAME,
      language: { code: 'en_US' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: member.name },
            { type: 'text', text: renewal.razorpay_short_url },
          ],
        },
      ],
    },
  };

  logger.debug('[whatsappService] Sending renewal reminder', {
    gym_id: gym.id,
    renewal_id: renewal.id,
    member_id: member.id,
    to: member.phone,
    template: TEMPLATE_NAME,
  });

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${gym.whatsapp_access_token}`,
      'Content-Type': 'application/json',
    },
  });

  // Meta Cloud API success shape: { messages: [{ id: "wamid.xxx" }] }
  const messageId = response.data?.messages?.[0]?.id ?? null;

  logger.info('[whatsappService] Reminder sent successfully', {
    gym_id: gym.id,
    renewal_id: renewal.id,
    member_id: member.id,
    whatsapp_message_id: messageId,
  });

  return { messageId, status: 'sent' };
}

/**
 * Sends a daily summary WhatsApp message to the gym owner via Meta Cloud API
 * using the "daily_summary" message template.
 *
 * Template body parameters (positional):
 *   {{1}} — remindersSent   (number of WhatsApp reminders sent today)
 *   {{2}} — renewalsPaid    (number of renewals paid today)
 *   {{3}} — revenueRecovered (total amount collected today, formatted as string)
 *   {{4}} — pendingCount    (renewals still pending/link_generated)
 *
 * @param {{ id: number, whatsapp_phone_number_id: string, whatsapp_access_token: string, owner_phone: string }} gym
 * @param {{ remindersSent: number, renewalsPaid: number, revenueRecovered: string, pendingCount: number }} stats
 * @returns {Promise<{ messageId: string|null }>}
 * @throws Will throw if the Meta API returns a non-2xx response.
 */
async function sendDailySummary(gym, stats) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${gym.whatsapp_phone_number_id}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to: gym.owner_phone,
    type: 'template',
    template: {
      name: SUMMARY_TEMPLATE_NAME,
      language: { code: 'en_US' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: String(stats.remindersSent) },
            { type: 'text', text: String(stats.renewalsPaid) },
            { type: 'text', text: stats.revenueRecovered },
            { type: 'text', text: String(stats.pendingCount) },
          ],
        },
      ],
    },
  };

  logger.debug('[whatsappService] Sending daily summary', {
    gym_id: gym.id,
    to: gym.owner_phone,
    template: SUMMARY_TEMPLATE_NAME,
    stats,
  });

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${gym.whatsapp_access_token}`,
      'Content-Type': 'application/json',
    },
  });

  const messageId = response.data?.messages?.[0]?.id ?? null;

  logger.info('[whatsappService] Daily summary sent successfully', {
    gym_id: gym.id,
    whatsapp_message_id: messageId,
  });

  return { messageId };
}

module.exports = { sendRenewalReminder, sendDailySummary };
