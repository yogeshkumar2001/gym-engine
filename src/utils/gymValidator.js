'use strict';

const Joi = require('joi');

const createGymSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  razorpay_key_id: Joi.string().trim().required(),
  razorpay_key_secret: Joi.string().trim().required(),
  razorpay_webhook_secret: Joi.string().trim().required(),
  whatsapp_phone_number_id: Joi.string().trim().required(),
  whatsapp_access_token: Joi.string().trim().required(),
  google_sheet_id: Joi.string().trim().required(),
  owner_phone: Joi.string()
    .trim()
    .pattern(/^\+?[1-9]\d{9,14}$/)
    .required()
    .messages({ 'string.pattern.base': 'owner_phone must be a valid E.164 phone number.' }),
});

module.exports = { createGymSchema };
