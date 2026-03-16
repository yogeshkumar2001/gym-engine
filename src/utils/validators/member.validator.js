'use strict';

const Joi = require('joi');

const createMemberSchema = Joi.object({
  name:               Joi.string().trim().min(1).max(255).required(),
  phone:              Joi.string().trim().pattern(/^\d{10,15}$/).required().messages({
    'string.pattern.base': '"phone" must be 10–15 digits.',
  }),
  plan_name:          Joi.string().trim().min(1).max(255).required(),
  plan_amount:        Joi.number().positive().required(),
  plan_duration_days: Joi.number().integer().min(1).required(),
  join_date:          Joi.date().iso().required(),
});

const updateMemberSchema = Joi.object({
  name:               Joi.string().trim().min(1).max(255),
  phone:              Joi.string().trim().pattern(/^\d{10,15}$/).messages({
    'string.pattern.base': '"phone" must be 10–15 digits.',
  }),
  plan_name:          Joi.string().trim().min(1).max(255),
  plan_amount:        Joi.number().positive(),
  plan_duration_days: Joi.number().integer().min(1),
  join_date:          Joi.date().iso(),
}).min(1);

const updateProfileSchema = Joi.object({
  photo_url:       Joi.string().uri().max(2048),
  id_proof_type:   Joi.string().valid('aadhar', 'pan', 'voter'),
  id_proof_number: Joi.string().trim().min(1).max(100),
  id_proof_url:    Joi.string().uri().max(2048),
}).min(1).custom((value, helpers) => {
  const hasType   = value.id_proof_type   !== undefined;
  const hasNumber = value.id_proof_number !== undefined;
  if (hasType && !hasNumber) {
    return helpers.error('any.invalid', { message: '"id_proof_number" is required when "id_proof_type" is provided.' });
  }
  if (hasNumber && !hasType) {
    return helpers.error('any.invalid', { message: '"id_proof_type" is required when "id_proof_number" is provided.' });
  }
  return value;
});

module.exports = { createMemberSchema, updateMemberSchema, updateProfileSchema };
