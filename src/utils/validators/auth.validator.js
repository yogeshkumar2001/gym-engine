'use strict';

const Joi = require('joi');

const registerGymSchema = Joi.object({
  gym_name: Joi.string().trim().min(1).max(255).required(),
  owner_name: Joi.string().trim().min(1).max(255).required(),
  email: Joi.string().email().lowercase().required(),
  phone: Joi.string().trim().min(1).max(20).required(),
  password: Joi.string().min(8).required(),
});

const loginSchema = Joi.object({
  email: Joi.string().email().lowercase().required(),
  password: Joi.string().required(),
});

module.exports = { registerGymSchema, loginSchema };
