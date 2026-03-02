'use strict';

const express = require('express');
const router = express.Router();
const {
  testDuplicateWebhook,
  testMidCronRace,
  testRazorpayFailure,
  testWhatsappFailure,
  testConcurrency,
} = require('../controllers/systemTest.controller');

// ⚠️  Internal test routes — do not expose in production behind a public domain.
//     Tests 1, 2, 5 write to the DB permanently. Use only with test renewals.

router.post('/test-duplicate-webhook/:renewalId', testDuplicateWebhook);
router.post('/test-mid-cron-race/:renewalId', testMidCronRace);
router.post('/test-razorpay-failure/:renewalId', testRazorpayFailure);
router.post('/test-whatsapp-failure/:renewalId', testWhatsappFailure);
router.post('/test-concurrency/:renewalId', testConcurrency);

module.exports = router;
