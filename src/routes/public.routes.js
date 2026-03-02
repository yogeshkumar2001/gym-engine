'use strict';

const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/auth.controller');
const onboardingController = require('../controllers/onboarding.controller');

const router = Router();

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again after 15 minutes.' },
});

router.use(strictLimiter);

router.post('/register-gym', authController.register);
router.post('/login', authController.login);
router.post('/submit-credentials', onboardingController.submitGymCredentials);

module.exports = router;
