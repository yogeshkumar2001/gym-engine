'use strict';

const { Router } = require('express');
const verifyAdmin = require('../middleware/verifyAdmin');
const adminController = require('../controllers/admin.controller');

const router = Router();

// All /admin/* routes require a valid X-Admin-Key header.
// This guard runs before every handler defined below.
router.use(verifyAdmin);

router.get('/global-health', adminController.globalHealth);
router.get('/gym/:gymId/deep-health', adminController.gymDeepHealth);

module.exports = router;
