'use strict';

const { Router } = require('express');
const verifyJWT = require('../middleware/verifyJWT');
const ownerController = require('../controllers/owner.controller');

const router = Router();

router.use(verifyJWT);

router.get('/health', ownerController.getHealth);

module.exports = router;
