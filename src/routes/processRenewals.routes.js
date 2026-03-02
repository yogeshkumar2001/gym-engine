'use strict';

const express = require('express');
const router = express.Router();
const { processRenewals } = require('../controllers/processRenewals.controller');

router.post('/:gymId', processRenewals);

module.exports = router;
