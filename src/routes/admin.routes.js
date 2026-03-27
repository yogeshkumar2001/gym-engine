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

// Service flags
router.get('/gym/:gymId/services',   adminController.getGymServices);
router.patch('/gym/:gymId/services', adminController.updateGymServices);

// Discount settings
router.patch('/gym/:gymId/discounts', adminController.updateGymDiscounts);

// Analytics — Revenue Forecasting + LTV
router.get('/gym/:gymId/forecast', analyticsController.revenueForecast);
router.get('/gym/:gymId/ltv-report', analyticsController.ltvReport);
router.get('/gym/:gymId/plan-report', analyticsController.planReport);

// Recovery Engine
router.get('/gym/:gymId/recovery-stats', adminController.getRecoveryStats);

// Reactivation + Lead Funnel
router.get('/gym/:gymId/reactivation-stats', adminController.getReactivationStats);
router.get('/gym/:gymId/lead-stats', adminController.getLeadStats);

// Multi-gym: link owner to additional gym
router.post('/gym/:gymId/owners', adminController.linkOwnerToGym);

// Cohort + Retention (admin view)
router.get('/gym/:gymId/cohorts',   analyticsController.cohortReport);
router.get('/gym/:gymId/retention', analyticsController.retentionCurve);

// WhatsApp system health
router.get('/health/whatsapp', adminController.getWhatsappHealth);

// Manually activate a gym's WhatsApp (bypass auto-detection)
router.post('/gym/:gymId/activate-whatsapp', adminController.activateGymWhatsapp);

module.exports = router;
