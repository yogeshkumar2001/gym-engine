'use strict';

const express = require('express');
const router = express.Router();
const { triggerReminder } = require('../controllers/reminder.controller');

router.post('/:gymId/:memberId', triggerReminder);

module.exports = router;
