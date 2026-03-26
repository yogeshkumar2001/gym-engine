'use strict';

const express = require('express');
const router = express.Router();
const { verifyWebhookChallenge, handleWhatsAppWebhook } = require('../controllers/whatsappWebhook.controller');

/**
 * Raw-body middleware: captures the request body as a Buffer and attaches it
 * to req.rawBody before express.json() parses it.
 * Must be applied here (not globally) since it conflicts with express.json().
 */
const rawBodyMiddleware = express.raw({ type: 'application/json' });

// Meta webhook verification (one-time GET during webhook registration)
router.get('/webhook', verifyWebhookChallenge);

// Meta event delivery (delivery status updates + incoming messages)
router.post('/webhook', rawBodyMiddleware, handleWhatsAppWebhook);

module.exports = router;
