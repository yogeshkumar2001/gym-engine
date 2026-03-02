'use strict';

const gymService = require('../services/gym.service');
const { createGymSchema } = require('../utils/gymValidator');
const { sendSuccess, sendError } = require('../utils/response');
const logger = require('../config/logger');

const createGym = async (req, res, next) => {
  try {
    const { error, value } = createGymSchema.validate(req.body, { abortEarly: false });

    if (error) {
      const messages = error.details.map((d) => d.message);
      return sendError(res, 'Validation failed.', 400, messages);
    }

    const gym = await gymService.createGym(value);
    logger.info(`Gym created: id=${gym.id}, name=${gym.name}`);

    return sendSuccess(
      res,
      { id: gym.id, name: gym.name, owner_phone: gym.owner_phone, created_at: gym.created_at },
      'Gym created successfully.',
      201
    );
  } catch (err) {
    next(err);
  }
};

const getGym = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id) || id <= 0) {
      return sendError(res, 'Invalid gym ID.', 400);
    }

    const gym = await gymService.getGymById(id);

    if (!gym) {
      return sendError(res, 'Gym not found.', 404);
    }

    return sendSuccess(res, gym);
  } catch (err) {
    next(err);
  }
};

module.exports = { createGym, getGym };
