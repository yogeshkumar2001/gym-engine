'use strict';

const express = require('express');
const router = express.Router();
const { handleRazorpayWebhook } = require('../controllers/webhook.controller');

// express.raw() captures the body as a Buffer before express.json() touches it.
// This is required for HMAC signature verification.
router.post(
  '/razorpay/:gymId',
  express.raw({ type: 'application/json' }),
  handleRazorpayWebhook
);

module.exports = router;
