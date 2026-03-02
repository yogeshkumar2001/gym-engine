'use strict';

const express = require('express');
const router = express.Router();
const syncController = require('../controllers/sync.controller');

router.post('/:gymId', syncController.syncMembers);

module.exports = router;
