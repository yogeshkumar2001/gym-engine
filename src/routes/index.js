'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const prisma = require('../lib/prisma');
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
const { syncAllGymMembers } = require('../cron/memberSyncCron');

// Stricter rate limit for admin cron-trigger endpoints (expensive operations).
// The global 100/15min limiter in server.js still applies on top of this.
const adminOpLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please wait before triggering again.' },
});

// ─── Public ───────────────────────────────────────────────────────────────────

router.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({
      success: true,
      message: 'Server is healthy.',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
    });
  } catch {
    res.status(503).json({
      success: false,
      message: 'Database unavailable.',
      timestamp: new Date().toISOString(),
    });
  }
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

// Manual cron triggers — admin only + stricter rate limit; useful for one-off back-fills.
router.post('/test-cron', verifyAdmin, adminOpLimiter, async (_req, res, next) => {
  try {
    await detectExpiringMembers();
    res.status(200).json({ success: true, message: 'Cron executed. Check server logs.' });
  } catch (err) {
    next(err);
  }
});

router.post('/test-summary-cron', verifyAdmin, adminOpLimiter, async (_req, res, next) => {
  try {
    await sendDailySummaries();
    res.status(200).json({ success: true, message: 'Summary cron executed. Check server logs.' });
  } catch (err) {
    next(err);
  }
});

router.post('/test-sync-cron', verifyAdmin, adminOpLimiter, async (_req, res, next) => {
  try {
    await syncAllGymMembers();
    res.status(200).json({ success: true, message: 'Member sync cron executed. Check server logs.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
