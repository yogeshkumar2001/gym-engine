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
const manualPaymentController = require('../controllers/manualPayment.controller');
const discountController       = require('../controllers/discount.controller');
const attendanceController     = require('../controllers/attendance.controller');
const whatsappConfigController = require('../controllers/whatsappConfig.controller');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const router = Router();

router.use(verifyJWT);

router.get('/health', ownerController.getHealth);
router.get('/my-gyms', ownerController.getMyGyms);
router.post('/sync', ownerController.triggerSync);
router.patch('/credentials', ownerController.patchCredentials);
router.get('/subscription', ownerController.getSubscription);
router.get('/services', ownerController.getServices);
router.patch('/services', ownerController.updateServices);
router.get('/settings/discounts',  discountController.getDiscounts);
router.patch('/settings/discounts', discountController.updateDiscounts);
router.get('/settings/upi',  ownerController.getUpiSettings);
router.patch('/settings/upi', ownerController.updateUpiSettings);
router.get('/settings/whatsapp',        whatsappConfigController.getWhatsappConfig);
router.patch('/settings/whatsapp',      whatsappConfigController.updateWhatsappConfig);
router.get('/settings/recovery',        whatsappConfigController.getRecoveryConfig);
router.patch('/settings/recovery',      whatsappConfigController.updateRecoveryConfig);
router.get('/settings/winback',         whatsappConfigController.getWinbackConfig);
router.patch('/settings/winback',       whatsappConfigController.updateWinbackConfig);
router.get('/settings/notifications',   whatsappConfigController.getNotificationConfig);
router.patch('/settings/notifications', whatsappConfigController.updateNotificationConfig);

// Members — specific routes MUST come before /:memberId param route
router.get('/members/summary',  memberController.getMemberSummary);
router.get('/members/at-risk',  memberController.getAtRiskMembers);
router.post('/members/import',      upload.single('file'), importController.importMembers);
router.post('/members/import/bulk', importController.bulkImportMembers);
router.get('/members',          memberController.listMembers);
router.post('/members',         memberController.createMember);
router.post('/members/:memberId/mark-paid',           manualPaymentController.markMemberPaid);
router.post('/members/:memberId/checkin',             attendanceController.checkIn);
router.post('/members/:memberId/checkout',            attendanceController.checkOut);
router.get('/members/:memberId/attendance-stats',     attendanceController.getMemberAttendanceStats);
router.patch('/members/:memberId/profile', memberController.updateMemberProfile);
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
router.get('/analytics/forecast',  analyticsController.revenueForecast);
router.get('/analytics/ltv',       analyticsController.ltvReport);
router.get('/analytics/plans',     analyticsController.planReport);
router.get('/analytics/cohorts',   analyticsController.cohortReport);
router.get('/analytics/retention', analyticsController.retentionCurve);

// Attendance — /stats must come before any param route
router.get('/attendance/stats',  attendanceController.getAttendanceStats);
router.get('/attendance',        attendanceController.listAttendance);

// Lead Funnel
router.post('/leads',                   leadController.createLead);
router.get('/leads/funnel',             leadController.getFunnelStats);
router.get('/leads',                    leadController.getLeads);
router.patch('/leads/:leadId/stage',    leadController.updateLeadStage);

module.exports = router;
