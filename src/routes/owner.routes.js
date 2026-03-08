'use strict';

const { Router } = require('express');
const verifyJWT = require('../middleware/verifyJWT');
const ownerController = require('../controllers/owner.controller');
const analyticsController = require('../controllers/analytics.controller');

const router = Router();

router.use(verifyJWT);

router.get('/health', ownerController.getHealth);

// Analytics — scoped to the authenticated owner's gym
router.get('/analytics/forecast', analyticsController.revenueForecast);
router.get('/analytics/ltv', analyticsController.ltvReport);
router.get('/analytics/plans', analyticsController.planReport);

module.exports = router;
