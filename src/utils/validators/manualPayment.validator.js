'use strict';

const Joi = require('joi');

const markPaidSchema = Joi.object({
  payment_method: Joi.string().valid('cash', 'upi').required(),
  amount:         Joi.number().positive().required(),
});

module.exports = { markPaidSchema };
