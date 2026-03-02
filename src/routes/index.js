'use strict';

const express = require('express');
const router = express.Router();
const gymRoutes = require('./gym.routes');
const expiryRoutes = require('./expiry.routes');
const reminderRoutes = require('./reminder.routes');
const processRenewalsRoutes = require('./processRenewals.routes');
const sendRenewalsRoutes = require('./sendRenewals.routes');
const systemTestRoutes = require('./systemTest.routes');
const { detectExpiringMembers } = require('../cron/expiryCron');
const { sendDailySummaries } = require('../cron/summaryCron');

router.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is healthy.',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

router.use('/gym', gymRoutes);
router.use('/test-expiry', expiryRoutes);
router.use('/trigger-reminder', reminderRoutes);
router.use('/process-renewals', processRenewalsRoutes);
router.use('/send-renewals', sendRenewalsRoutes);
router.use('/system-test', systemTestRoutes);

router.post('/test-cron', async (_req, res, next) => {
  try {
    await detectExpiringMembers();
    res.status(200).json({ success: true, message: 'Cron executed. Check server logs.' });
  } catch (err) {
    next(err);
  }
});

router.post('/test-summary-cron', async (_req, res, next) => {
  try {
    await sendDailySummaries();
    res.status(200).json({ success: true, message: 'Summary cron executed. Check server logs.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
