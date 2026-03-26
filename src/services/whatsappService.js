'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const logger = require('../config/logger');
const WhatsAppService = require('./whatsapp/WhatsAppService');

const GRAPH_API_VERSION = 'v22.0';

/**
 * Sends a WhatsApp renewal reminder.
 * Template: renewal_reminder  |  params: [name, payment_url]
 */
async function sendRenewalReminder(gym, renewal, member) {
  const params = [member.name, renewal.razorpay_short_url];
  return WhatsAppService.send(gym.id, member.id, 'renewal_reminder', params, member.phone);
}

/**
 * Sends a WhatsApp renewal reminder with a UPI deep link.
 * Template: renewal_reminder_upi  |  params: [name, amount, upi_url]
 */
async function sendRenewalReminderUpi(gym, renewal, member, upiUrl) {
  const params = [member.name, `₹${renewal.amount}`, upiUrl];
  return WhatsAppService.send(gym.id, member.id, 'renewal_reminder_upi', params, member.phone);
}

/**
 * Sends the daily summary to the gym owner.
 * Template: daily_summary  |  params: [remindersSent, renewalsPaid, revenueRecovered, pendingCount]
 */
async function sendDailySummary(gym, stats) {
  const params = [
    String(stats.remindersSent),
    String(stats.renewalsPaid),
    String(stats.revenueRecovered),
    String(stats.pendingCount),
  ];
  return WhatsAppService.send(gym.id, null, 'daily_summary', params, gym.owner_phone);
}

/**
 * Sends a payment confirmation template immediately (bypasses queue — post-webhook).
 * Template: payment_confirm  |  params: [name, amount, plan_name, expiry_date]
 * Also sends the invoice PDF as a WhatsApp document if invoicePath is provided.
 */
async function sendPaymentConfirmation(gym, member, renewal, newExpiry, invoicePath) {
  const formattedExpiry = new Date(newExpiry).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

  const params = [
    member.name,
    `Rs. ${Number(renewal.amount).toFixed(2)}`,
    member.plan_name,
    formattedExpiry,
  ];

  await WhatsAppService.sendImmediate(gym.id, 'payment_confirm', params, member.phone);

  // Invoice PDF — upload via system token + gym's phone_number_id
  if (invoicePath) {
    await _sendInvoiceDocument(gym, member, renewal, invoicePath);
  }
}

/**
 * Uploads an invoice PDF and sends it as a WhatsApp document using the
 * system token and the gym's registered phone_number_id.
 * Failures are logged but never thrown (payment confirmation already sent).
 */
async function _sendInvoiceDocument(gym, member, renewal, invoicePath) {
  try {
    const { getActiveToken } = require('./whatsapp/TokenManager');
    const prisma = require('../lib/prisma');

    const [{ access_token }, account] = await Promise.all([
      getActiveToken(),
      prisma.whatsappAccount.findUnique({
        where: { gym_id: gym.id },
        select: { phone_number_id: true },
      }),
    ]);

    if (!account?.phone_number_id) {
      logger.warn('[whatsappService] _sendInvoiceDocument: no phone_number_id for gym', { gym_id: gym.id });
      return;
    }

    const phoneNumberId = account.phone_number_id;
    const headers = { Authorization: `Bearer ${access_token}` };

    // 1. Upload PDF
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'application/pdf');
    form.append('file', fs.createReadStream(invoicePath), {
      contentType: 'application/pdf',
      filename: path.basename(invoicePath),
    });

    const uploadResponse = await axios.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/media`,
      form,
      { headers: { ...headers, ...form.getHeaders() } }
    );

    const mediaId = uploadResponse.data.id;

    // 2. Send document
    await axios.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: member.phone,
        type: 'document',
        document: {
          id: mediaId,
          filename: `invoice_${renewal.id}.pdf`,
          caption: `Invoice — ${member.plan_name} plan | ${gym.name}`,
        },
      },
      { headers: { ...headers, 'Content-Type': 'application/json' } }
    );

    logger.info('[whatsappService] Invoice document sent', {
      gym_id: gym.id,
      renewal_id: renewal.id,
      member_id: member.id,
      media_id: mediaId,
    });
  } catch (err) {
    logger.warn('[whatsappService] _sendInvoiceDocument failed — swallowing', {
      gym_id: gym.id,
      renewal_id: renewal.id,
      error: err.message,
    });
  }
}

/**
 * Recovery Step 1 — follow-up reminder.
 * Template: recovery_day1  |  params: [name, payment_url]
 */
async function sendRecoveryFollowup(gym, renewal, member) {
  const params = [member.name, renewal.razorpay_short_url];
  return WhatsAppService.send(gym.id, member.id, 'recovery_day1', params, member.phone, {
    trigger_type: 'recovery_engine',
  });
}

/**
 * Recovery Step 2 — discount offer.
 * Template: recovery_discount  |  params: [name, discount_pct, payment_url]
 */
async function sendDiscountOffer(gym, renewal, member, discountPercent) {
  const params = [member.name, String(discountPercent), renewal.razorpay_short_url];
  return WhatsAppService.send(gym.id, member.id, 'recovery_discount', params, member.phone, {
    trigger_type: 'recovery_engine',
  });
}

/**
 * Recovery Step 3 — final notice.
 * Template: recovery_final  |  params: [name, payment_url]
 */
async function sendFinalNotice(gym, renewal, member) {
  const params = [member.name, renewal.razorpay_short_url];
  return WhatsAppService.send(gym.id, member.id, 'recovery_final', params, member.phone, {
    trigger_type: 'recovery_engine',
  });
}

/**
 * Win-back offer for churned members.
 * Template: winback  |  params: [name, discount_pct, gym_name]
 */
async function sendReactivationOffer(gym, member, discountPercent) {
  const params = [member.name, String(discountPercent), gym.name];
  return WhatsAppService.send(gym.id, member.id, 'winback', params, member.phone, {
    trigger_type: 'winback',
  });
}

/**
 * Trial welcome message for a new lead.
 * Template: trial_welcome  |  params: [name, gym_name]
 */
async function sendTrialWelcome(gym, member) {
  const params = [member.name, gym.name];
  return WhatsAppService.send(gym.id, member.id, 'trial_welcome', params, member.phone);
}

/**
 * Trial follow-up nudge to convert.
 * Template: trial_followup  |  params: [name, gym_name]
 */
async function sendTrialFollowup(gym, member) {
  const params = [member.name, gym.name];
  return WhatsAppService.send(gym.id, member.id, 'trial_followup', params, member.phone);
}

module.exports = {
  sendRenewalReminder,
  sendRenewalReminderUpi,
  sendDailySummary,
  sendPaymentConfirmation,
  sendRecoveryFollowup,
  sendDiscountOffer,
  sendFinalNotice,
  sendReactivationOffer,
  sendTrialWelcome,
  sendTrialFollowup,
};
