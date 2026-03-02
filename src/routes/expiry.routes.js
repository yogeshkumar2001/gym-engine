'use strict';

const express = require('express');
const router = express.Router();
const { testExpiry } = require('../controllers/expiry.controller');

router.get('/:gymId', testExpiry);

module.exports = router;
