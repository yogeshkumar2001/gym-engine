'use strict';

const express = require('express');
const router = express.Router();
const { syncMembers } = require('../controllers/syncController');

router.post('/:gymId', syncMembers);

module.exports = router;