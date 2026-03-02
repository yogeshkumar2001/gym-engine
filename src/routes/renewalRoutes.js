'use strict';

const express = require('express');
const router = express.Router();
const { triggerRenewal } = require('../controllers/renewalController');

router.post('/:gymId/:memberId', triggerRenewal);

module.exports = router;
