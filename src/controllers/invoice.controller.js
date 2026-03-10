'use strict';

const fs = require('fs');
const prisma = require('../lib/prisma');
const { sendSuccess, sendError } = require('../utils/response');
const { generateInvoicePDF } = require('../services/invoiceService');

/**
 * GET /owner/invoices/summary
 */
async function getInvoiceSummary(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  try {
    const [totalCount, monthCount, totalRevenue, monthRevenue] = await Promise.all([
      prisma.renewal.count({ where: { gym_id: gymId, status: 'paid' } }),
      prisma.renewal.count({ where: { gym_id: gymId, status: 'paid', updated_at: { gte: startOfMonth } } }),
      prisma.renewal.aggregate({ where: { gym_id: gymId, status: 'paid' }, _sum: { amount: true } }),
      prisma.renewal.aggregate({ where: { gym_id: gymId, status: 'paid', updated_at: { gte: startOfMonth } }, _sum: { amount: true } }),
    ]);

    return sendSuccess(res, {
      total_invoices: totalCount,
      this_month:     monthCount,
      total_revenue:  totalRevenue._sum.amount  ?? 0,
      month_revenue:  monthRevenue._sum.amount  ?? 0,
    }, 'Invoice summary retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /owner/invoices?limit=50&offset=0
 */
async function listInvoices(req, res, next) {
  const gymId = req.gymOwner.gym_id;
  const { limit = 50, offset = 0 } = req.query;
  const take = Math.min(parseInt(limit, 10) || 50, 200);
  const skip = parseInt(offset, 10) || 0;

  try {
    const [invoices, total] = await Promise.all([
      prisma.renewal.findMany({
        where: { gym_id: gymId, status: 'paid' },
        select: {
          id: true,
          amount: true,
          plan_duration_days: true,
          razorpay_payment_link_id: true,
          updated_at: true,
          member: {
            select: { id: true, name: true, phone: true, plan_name: true, expiry_date: true },
          },
        },
        orderBy: { updated_at: 'desc' },
        take,
        skip,
      }),
      prisma.renewal.count({ where: { gym_id: gymId, status: 'paid' } }),
    ]);

    return sendSuccess(res, { invoices, total }, 'Invoices retrieved.');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /owner/invoices/:renewalId/download
 * Generates (or reuses cached) PDF and streams it to the client.
 */
async function downloadInvoice(req, res, next) {
  const gymId    = req.gymOwner.gym_id;
  const renewalId = parseInt(req.params.renewalId, 10);

  if (!Number.isInteger(renewalId) || renewalId <= 0) {
    return sendError(res, 'Invalid renewalId.', 400);
  }

  try {
    const renewal = await prisma.renewal.findUnique({
      where: { id: renewalId },
      include: {
        member: { select: { id: true, name: true, phone: true, plan_name: true, expiry_date: true } },
      },
    });

    if (!renewal || renewal.gym_id !== gymId || renewal.status !== 'paid') {
      return sendError(res, 'Invoice not found.', 404);
    }

    const gym = await prisma.gym.findUnique({
      where: { id: gymId },
      select: { id: true, name: true },
    });

    const filePath = await generateInvoicePDF(
      gym,
      renewal.member,
      renewal,
      renewal.member.expiry_date
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${renewalId}.pdf"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    next(err);
  }
}

module.exports = { getInvoiceSummary, listInvoices, downloadInvoice };
