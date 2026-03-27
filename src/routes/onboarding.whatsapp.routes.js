'use strict';

const { Router } = require('express');
const verifyJWT = require('../middleware/verifyJWT');
const {
  startWhatsappOnboarding,
  verifyWhatsappOTP,
  getWhatsappStatus,
} = require('../controllers/onboarding.whatsapp.controller');

const router = Router();

router.use(verifyJWT);

router.post('/start', startWhatsappOnboarding);
router.post('/verify-otp', verifyWhatsappOTP);
router.get('/status', getWhatsappStatus);

module.exports = router;
