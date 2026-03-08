'use strict';

const { Router } = require('express');
const verifyJWT = require('../middleware/verifyJWT');
const ownerController = require('../controllers/owner.controller');
const analyticsController = require('../controllers/analytics.controller');
const leadController = require('../controllers/lead.controller');

const router = Router();

router.use(verifyJWT);

router.get('/health', ownerController.getHealth);

// Analytics — scoped to the authenticated owner's gym
router.get('/analytics/forecast', analyticsController.revenueForecast);
router.get('/analytics/ltv', analyticsController.ltvReport);
router.get('/analytics/plans', analyticsController.planReport);

// Lead Funnel
router.post('/leads', leadController.createLead);
router.get('/leads/funnel', leadController.getFunnelStats);
router.get('/leads', leadController.getLeads);
router.patch('/leads/:leadId/stage', leadController.updateLeadStage);

module.exports = router;
