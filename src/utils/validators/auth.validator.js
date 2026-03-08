'use strict';

const Joi = require('joi');

const registerGymSchema = Joi.object({
  gym_name:   Joi.string().trim().min(1).max(255).required(),
  owner_name: Joi.string().trim().min(1).max(255).required(),
  phone:      Joi.string().trim().min(10).max(15).required(),
  pin:        Joi.string().pattern(/^\d{4,6}$/).required().messages({
    'string.pattern.base': '"pin" must be 4–6 digits.',
  }),
});

const loginSchema = Joi.object({
  phone: Joi.string().trim().min(10).max(15).required(),
  pin:   Joi.string().pattern(/^\d{4,6}$/).required(),
});

module.exports = { registerGymSchema, loginSchema };
