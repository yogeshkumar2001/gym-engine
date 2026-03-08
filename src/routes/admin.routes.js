'use strict';

const { Router } = require('express');
const verifyAdmin = require('../middleware/verifyAdmin');
const adminController = require('../controllers/admin.controller');
const analyticsController = require('../controllers/analytics.controller');

const router = Router();

// All /admin/* routes require a valid X-Admin-Key header.
// This guard runs before every handler defined below.
router.use(verifyAdmin);

router.get('/global-health', adminController.globalHealth);
router.get('/gyms', adminController.listGyms);
router.get('/gym/:gymId/deep-health', adminController.gymDeepHealth);
router.patch('/gym/:gymId/subscription', adminController.updateGymSubscription);

// Analytics — Revenue Forecasting + LTV
router.get('/gym/:gymId/forecast', analyticsController.revenueForecast);
router.get('/gym/:gymId/ltv-report', analyticsController.ltvReport);
router.get('/gym/:gymId/plan-report', analyticsController.planReport);

// Recovery Engine
router.get('/gym/:gymId/recovery-stats', adminController.getRecoveryStats);

// Reactivation + Lead Funnel
router.get('/gym/:gymId/reactivation-stats', adminController.getReactivationStats);
router.get('/gym/:gymId/lead-stats', adminController.getLeadStats);

module.exports = router;
