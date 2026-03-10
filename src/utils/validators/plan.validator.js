'use strict';

const Joi = require('joi');

const createPlanSchema = Joi.object({
  name:          Joi.string().trim().min(1).max(255).required(),
  duration_days: Joi.number().integer().min(1).required(),
  price:         Joi.number().positive().required(),
  status:        Joi.string().valid('active', 'inactive').default('active'),
});

const updatePlanSchema = Joi.object({
  name:          Joi.string().trim().min(1).max(255),
  duration_days: Joi.number().integer().min(1),
  price:         Joi.number().positive(),
  status:        Joi.string().valid('active', 'inactive'),
}).min(1);

module.exports = { createPlanSchema, updatePlanSchema };
