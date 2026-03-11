'use strict';

const { Router } = require('express');
const multer = require('multer');
const verifyJWT = require('../middleware/verifyJWT');
const ownerController = require('../controllers/owner.controller');
const analyticsController = require('../controllers/analytics.controller');
const leadController = require('../controllers/lead.controller');
const memberController = require('../controllers/member.controller');
const importController = require('../controllers/import.controller');
const planController = require('../controllers/plan.controller');
const renewalController = require('../controllers/renewal.controller');
const invoiceController = require('../controllers/invoice.controller');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const router = Router();

router.use(verifyJWT);

router.get('/health', ownerController.getHealth);
router.post('/sync', ownerController.triggerSync);
router.patch('/credentials', ownerController.patchCredentials);

// Members — specific routes MUST come before /:memberId param route
router.get('/members/summary',  memberController.getMemberSummary);
router.get('/members/at-risk',  memberController.getAtRiskMembers);
router.post('/members/import',      upload.single('file'), importController.importMembers);
router.post('/members/import/bulk', importController.bulkImportMembers);
router.get('/members',          memberController.listMembers);
router.post('/members',         memberController.createMember);
router.patch('/members/:memberId', memberController.updateMember);
router.delete('/members/:memberId', memberController.deleteMember);
router.get('/members/:memberId', memberController.getMember);

// Plans — specific routes MUST come before /:planId param route
router.get('/plans/summary',    planController.getPlanSummary);
router.post('/plans/seed',      planController.seedPlansFromMembers);
router.get('/plans',            planController.listPlans);
router.post('/plans',           planController.createPlan);
router.patch('/plans/:planId',  planController.updatePlan);
router.delete('/plans/:planId', planController.deletePlan);

// Invoices — /summary and /:renewalId/download before any generic param
router.get('/invoices/summary',                invoiceController.getInvoiceSummary);
router.get('/invoices',                        invoiceController.listInvoices);
router.get('/invoices/:renewalId/download',    invoiceController.downloadInvoice);

// Renewals
router.get('/renewals', renewalController.listRenewals);

// Analytics
router.get('/analytics/forecast', analyticsController.revenueForecast);
router.get('/analytics/ltv',      analyticsController.ltvReport);
router.get('/analytics/plans',    analyticsController.planReport);

// Lead Funnel
router.post('/leads',                   leadController.createLead);
router.get('/leads/funnel',             leadController.getFunnelStats);
router.get('/leads',                    leadController.getLeads);
router.patch('/leads/:leadId/stage',    leadController.updateLeadStage);

module.exports = router;
