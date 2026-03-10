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

module.exports = { createMemberSchema, updateMemberSchema };
