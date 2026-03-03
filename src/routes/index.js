'use strict';

const express = require('express');
const router = express.Router();
const verifyAdmin = require('../middleware/verifyAdmin');
const gymRoutes = require('./gym.routes');
const expiryRoutes = require('./expiry.routes');
const reminderRoutes = require('./reminder.routes');
const processRenewalsRoutes = require('./processRenewals.routes');
const sendRenewalsRoutes = require('./sendRenewals.routes');
const syncRoutes = require('./syncRoutes');
const renewalRoutes = require('./renewalRoutes');
const { detectExpiringMembers } = require('../cron/expiryCron');
const { sendDailySummaries } = require('../cron/summaryCron');

// ─── Public ───────────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is healthy.',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// ─── Admin-protected operational routes ──────────────────────────────────────
// All routes below require a valid X-Admin-Key header.

router.use('/gym',              verifyAdmin, gymRoutes);
router.use('/sync',             verifyAdmin, syncRoutes);
router.use('/trigger-renewal',  verifyAdmin, renewalRoutes);
router.use('/test-expiry',      verifyAdmin, expiryRoutes);
router.use('/trigger-reminder', verifyAdmin, reminderRoutes);
router.use('/process-renewals', verifyAdmin, processRenewalsRoutes);
router.use('/send-renewals',    verifyAdmin, sendRenewalsRoutes);

// Manual cron triggers — admin only; useful for one-off back-fills.
router.post('/test-cron', verifyAdmin, async (_req, res, next) => {
  try {
    await detectExpiringMembers();
    res.status(200).json({ success: true, message: 'Cron executed. Check server logs.' });
  } catch (err) {
    next(err);
  }
});

router.post('/test-summary-cron', verifyAdmin, async (_req, res, next) => {
  try {
    await sendDailySummaries();
    res.status(200).json({ success: true, message: 'Summary cron executed. Check server logs.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
