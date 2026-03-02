'use strict';

const { submitCredentialsSchema } = require('../utils/validators/onboarding.validator');
const onboardingService = require('../services/onboarding.service');
const { sendSuccess, sendError } = require('../utils/response');

async function submitGymCredentials(req, res, next) {
  const { error, value } = submitCredentialsSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return sendError(res, 'Validation failed.', 400, error.details.map(d => d.message));
  }

  try {
    const result = await onboardingService.submitCredentials(value);

    if (!result.success) {
      return sendError(res, 'Credential validation failed.', 422, result.errors);
    }

    return sendSuccess(res, null, 'Credentials verified and gym activated.');
  } catch (err) {
    if (err.status === 403 || err.status === 404 || err.status === 409) {
      return sendError(res, err.message, err.status);
    }
    next(err);
  }
}

module.exports = { submitGymCredentials };
