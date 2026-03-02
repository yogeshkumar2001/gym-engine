'use strict';

const { registerGymSchema, loginSchema } = require('../utils/validators/auth.validator');
const authService = require('../services/auth.service');
const { sendSuccess, sendError } = require('../utils/response');

async function register(req, res, next) {
  const { error, value } = registerGymSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return sendError(res, 'Validation failed.', 400, error.details.map(d => d.message));
  }

  try {
    const result = await authService.registerGym(value);
    return sendSuccess(res, result, 'Gym registered successfully.', 201);
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  const { error, value } = loginSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return sendError(res, 'Validation failed.', 400, error.details.map(d => d.message));
  }

  try {
    const result = await authService.loginGymOwner(value);
    return sendSuccess(res, result, 'Login successful.');
  } catch (err) {
    if (err.status === 401) {
      return sendError(res, err.message, 401);
    }
    next(err);
  }
}

module.exports = { register, login };
