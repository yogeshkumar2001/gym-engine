'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const logger = require('../config/logger');

const GRAPH_API_VERSION = 'v22.0';
const TEMPLATE_NAME = 'renewal_reminder';
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
      language: { code: 'en' },
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
      language: { code: 'en' },
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

// ─── Payment confirmation ──────────────────────────────────────────────────────

/**
 * Uploads a PDF file to the WhatsApp media endpoint and returns the media_id.
 *
 * @param {{ whatsapp_phone_number_id: string, whatsapp_access_token: string }} gym
 * @param {string} filePath  absolute path to the PDF
 * @returns {Promise<string>} media_id
 */
async function uploadMedia(gym, filePath) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', fs.createReadStream(filePath), {
    contentType: 'application/pdf',
    filename: path.basename(filePath),
  });

  const response = await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${gym.whatsapp_phone_number_id}/media`,
    form,
    {
      headers: {
        Authorization: `Bearer ${gym.whatsapp_access_token}`,
        ...form.getHeaders(),
      },
    }
  );

  return response.data.id;
}

/**
 * Sends a payment confirmation template message followed by the invoice PDF
 * as a WhatsApp document to the member.
 *
 * Template: "payment_confirmation"
 * Parameters:
 *   {{1}} — member.name
 *   {{2}} — formatted plan amount (e.g. "₹1500.00")
 *   {{3}} — member.plan_name
 *   {{4}} — formatted new expiry date
 *
 * @param {{ id: number, name: string, whatsapp_phone_number_id: string, whatsapp_access_token: string }} gym
 * @param {{ id: number, name: string, phone: string, plan_name: string }} member
 * @param {{ id: number, amount: number }} renewal
 * @param {Date} newExpiry
 * @param {string} invoicePath  absolute path to the generated invoice PDF
 * @returns {Promise<void>}
 */
async function sendPaymentConfirmation(gym, member, renewal, newExpiry, invoicePath) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${gym.whatsapp_phone_number_id}/messages`;
  const headers = {
    Authorization: `Bearer ${gym.whatsapp_access_token}`,
    'Content-Type': 'application/json',
  };

  const formattedExpiry = new Date(newExpiry).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

  // 1. Send payment_confirmation template
  const confirmResponse = await axios.post(url, {
    messaging_product: 'whatsapp',
    to: member.phone,
    type: 'template',
    template: {
      name: 'payment_confirmation',
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: member.name },
            { type: 'text', text: `Rs. ${Number(renewal.amount).toFixed(2)}` },
            { type: 'text', text: member.plan_name },
            { type: 'text', text: formattedExpiry },
          ],
        },
      ],
    },
  }, { headers });

  logger.info('[whatsappService] Payment confirmation sent', {
    gym_id: gym.id,
    renewal_id: renewal.id,
    member_id: member.id,
    whatsapp_message_id: confirmResponse.data?.messages?.[0]?.id ?? null,
  });

  // 2. Upload invoice PDF → get media_id → send as document
  const mediaId = await uploadMedia(gym, invoicePath);

  await axios.post(url, {
    messaging_product: 'whatsapp',
    to: member.phone,
    type: 'document',
    document: {
      id: mediaId,
      filename: `invoice_${renewal.id}.pdf`,
      caption: `Invoice — ${member.plan_name} plan | ${gym.name}`,
    },
  }, { headers });

  logger.info('[whatsappService] Invoice document sent', {
    gym_id: gym.id,
    renewal_id: renewal.id,
    member_id: member.id,
    media_id: mediaId,
  });
}

// ─── Recovery Engine Templates ────────────────────────────────────────────────

/**
 * Recovery Step 1 — Follow-up reminder.
 * Template: "renewal_followup"
 * Parameters: {{1}} member.name, {{2}} renewal.razorpay_short_url
 */
async function sendRecoveryFollowup(gym, renewal, member) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${gym.whatsapp_phone_number_id}/messages`;
  const response = await axios.post(url, {
    messaging_product: 'whatsapp',
    to: member.phone,
    type: 'template',
    template: {
      name: 'renewal_followup',
      language: { code: 'en' },
      components: [{
        type: 'body',
        parameters: [
          { type: 'text', text: member.name },
          { type: 'text', text: renewal.razorpay_short_url },
        ],
      }],
    },
  }, {
    headers: {
      Authorization: `Bearer ${gym.whatsapp_access_token}`,
      'Content-Type': 'application/json',
    },
  });

  const messageId = response.data?.messages?.[0]?.id ?? null;
  logger.info('[whatsappService] Recovery follow-up sent', {
    gym_id: gym.id, renewal_id: renewal.id, member_id: member.id, whatsapp_message_id: messageId,
  });
  return { messageId };
}

/**
 * Recovery Step 2 — Discount offer.
 * Template: "renewal_discount_offer"
 * Parameters: {{1}} member.name, {{2}} discountPercent (e.g. "5"), {{3}} razorpay_short_url
 */
async function sendDiscountOffer(gym, renewal, member, discountPercent) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${gym.whatsapp_phone_number_id}/messages`;
  const response = await axios.post(url, {
    messaging_product: 'whatsapp',
    to: member.phone,
    type: 'template',
    template: {
      name: 'renewal_discount_offer',
      language: { code: 'en' },
      components: [{
        type: 'body',
        parameters: [
          { type: 'text', text: member.name },
          { type: 'text', text: String(discountPercent) },
          { type: 'text', text: renewal.razorpay_short_url },
        ],
      }],
    },
  }, {
    headers: {
      Authorization: `Bearer ${gym.whatsapp_access_token}`,
      'Content-Type': 'application/json',
    },
  });

  const messageId = response.data?.messages?.[0]?.id ?? null;
  logger.info('[whatsappService] Discount offer sent', {
    gym_id: gym.id, renewal_id: renewal.id, member_id: member.id,
    discount_percent: discountPercent, whatsapp_message_id: messageId,
  });
  return { messageId };
}

/**
 * Recovery Step 3 — Final notice (last chance).
 * Template: "renewal_final"
 * Parameters: {{1}} member.name, {{2}} renewal.razorpay_short_url
 */
async function sendFinalNotice(gym, renewal, member) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${gym.whatsapp_phone_number_id}/messages`;
  const response = await axios.post(url, {
    messaging_product: 'whatsapp',
    to: member.phone,
    type: 'template',
    template: {
      name: 'renewal_final',
      language: { code: 'en' },
      components: [{
        type: 'body',
        parameters: [
          { type: 'text', text: member.name },
          { type: 'text', text: renewal.razorpay_short_url },
        ],
      }],
    },
  }, {
    headers: {
      Authorization: `Bearer ${gym.whatsapp_access_token}`,
      'Content-Type': 'application/json',
    },
  });

  const messageId = response.data?.messages?.[0]?.id ?? null;
  logger.info('[whatsappService] Final notice sent', {
    gym_id: gym.id, renewal_id: renewal.id, member_id: member.id, whatsapp_message_id: messageId,
  });
  return { messageId };
}

module.exports = {
  sendRenewalReminder,
  sendDailySummary,
  sendPaymentConfirmation,
  sendRecoveryFollowup,
  sendDiscountOffer,
  sendFinalNotice,
};
