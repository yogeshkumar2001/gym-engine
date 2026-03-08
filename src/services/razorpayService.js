'use strict';

const Razorpay = require('razorpay');
const prisma = require('../lib/prisma');
const logger = require('../config/logger');

async function createRenewalPaymentLink(gym, member) {
  const razorpay = new Razorpay({
    key_id: gym.razorpay_key_id,
    key_secret: gym.razorpay_key_secret,
  });

  const amountPaise = Math.round(member.plan_amount * 100);

  const payload = {
    amount: amountPaise,
    currency: 'INR',
    description: 'Gym renewal',
    customer: {
      name: member.name,
      contact: member.phone,
    },
    notify: {
      sms: false,
      email: false,
    },
    reminder_enable: false,
  };

  logger.debug(
    `[razorpayService] Creating payment link for member ${member.id} (${member.name}), ` +
    `amount: ${amountPaise} paise`
  );

  const link = await razorpay.paymentLink.create(payload);

  logger.info(
    `[razorpayService] Payment link created: ${link.id} → ${link.short_url}`
  );

  // Persist to DB
  const payment = await prisma.payment.create({
    data: {
      gym_id: gym.id,
      member_id: member.id,
      razorpay_payment_link_id: link.id,
      amount: member.plan_amount,
      status: 'created',
    },
  });

  logger.info(`[razorpayService] Payment record saved: id=${payment.id}`);

  return {
    paymentLinkId: link.id,
    shortUrl: link.short_url,
  };
}

/**
 * Creates a Razorpay payment link for an existing Renewal record.
 * Uses renewal.amount (not member.plan_amount) and does NOT write to DB —
 * the caller is responsible for persisting the result.
 *
 * @param {{ id, razorpay_key_id, razorpay_key_secret }} gym
 * @param {{ id, amount }} renewal
 * @param {{ name, phone }} member
 * @returns {{ paymentLinkId: string, shortUrl: string }}
 */
async function createPaymentLinkForRenewal(gym, renewal, member) {
  const razorpay = new Razorpay({
    key_id: gym.razorpay_key_id,
    key_secret: gym.razorpay_key_secret,
  });

  const amountPaise = Math.round(renewal.amount * 100);

  logger.debug('[razorpayService] Creating payment link for renewal', {
    renewal_id: renewal.id,
    member_name: member.name,
    amountPaise,
  });

  const link = await razorpay.paymentLink.create({
    amount: amountPaise,
    currency: 'INR',
    description: 'Gym Membership Renewal',
    // reference_id scopes this link to a single renewal record.
    // Razorpay rejects a second create with the same reference_id,
    // providing API-level protection against duplicate link generation.
    reference_id: `renewal_${renewal.id}`,
    customer: {
      name: member.name,
      contact: member.phone,
    },
    notify: {
      sms: false,
      email: false,
    },
    reminder_enable: false,
  });

  logger.info(`[razorpayService] Payment link created: ${link.id} → ${link.short_url}`);

  return { paymentLinkId: link.id, shortUrl: link.short_url };
}

/**
 * Creates a Razorpay payment link at a discounted amount for recovery step 2.
 *
 * Uses reference_id `renewal_${renewal.id}_step2` to avoid Razorpay's
 * duplicate-reference rejection against the original link.
 * Does NOT write to DB — caller must persist via applyDiscountToRenewal().
 *
 * @param {{ id, razorpay_key_id, razorpay_key_secret }} gym
 * @param {{ id }} renewal
 * @param {{ name, phone }} member
 * @param {number} discountedAmount  — pre-computed discounted value in INR
 * @returns {{ paymentLinkId: string, shortUrl: string }}
 */
async function createDiscountedPaymentLink(gym, renewal, member, discountedAmount) {
  const razorpay = new Razorpay({
    key_id: gym.razorpay_key_id,
    key_secret: gym.razorpay_key_secret,
  });

  const amountPaise = Math.round(discountedAmount * 100);

  logger.debug('[razorpayService] Creating discounted payment link', {
    renewal_id: renewal.id,
    member_name: member.name,
    amountPaise,
  });

  const link = await razorpay.paymentLink.create({
    amount: amountPaise,
    currency: 'INR',
    description: 'Gym Membership Renewal — Special Offer',
    reference_id: `renewal_${renewal.id}_step2`,
    customer: {
      name: member.name,
      contact: member.phone,
    },
    notify: { sms: false, email: false },
    reminder_enable: false,
  });

  logger.info(`[razorpayService] Discounted link created: ${link.id} → ${link.short_url}`);

  return { paymentLinkId: link.id, shortUrl: link.short_url };
}

module.exports = { createRenewalPaymentLink, createPaymentLinkForRenewal, createDiscountedPaymentLink };
