'use strict';

const express = require('express');
const router = express.Router();
const { sendRenewals } = require('../controllers/sendRenewals.controller');

router.post('/:gymId', sendRenewals);

module.exports = router;
