'use strict';

const Joi = require('joi');

const submitCredentialsSchema = Joi.object({
  gym_id: Joi.number().integer().positive().required(),
  onboarding_token: Joi.string().uuid().required(),
  razorpay_key_id: Joi.string().trim().min(1).required(),
  razorpay_key_secret: Joi.string().trim().min(1).required(),
  razorpay_webhook_secret: Joi.string().trim().min(1).required(),
  whatsapp_phone_number_id: Joi.string().trim().min(1).required(),
  whatsapp_access_token: Joi.string().trim().min(1).required(),
  google_sheet_id: Joi.string().trim().min(1).required(),
});

module.exports = { submitCredentialsSchema };
