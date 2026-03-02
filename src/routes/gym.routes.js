'use strict';

const express = require('express');
const router = express.Router();
const gymController = require('../controllers/gym.controller');

router.post('/', gymController.createGym);
router.get('/:id', gymController.getGym);

module.exports = router;
