'use strict';

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');

const INVOICE_DIR = '/tmp/invoices';

/**
 * Generates a PDF invoice for a completed gym membership renewal.
 * Saves the file to /tmp/invoices/<renewalId>.pdf.
 *
 * @param {{ id: number, name: string }} gym
 * @param {{ id: number, name: string, phone: string, plan_name: string }} member
 * @param {{ id: number, amount: number, plan_duration_days: number, razorpay_payment_link_id: string|null }} renewal
 * @param {Date} newExpiry
 * @returns {Promise<string>} absolute path to the generated PDF
 */
async function generateInvoicePDF(gym, member, renewal, newExpiry) {
  if (!fs.existsSync(INVOICE_DIR)) {
    fs.mkdirSync(INVOICE_DIR, { recursive: true });
  }

  const filePath = path.join(INVOICE_DIR, `${renewal.id}.pdf`);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);

    // ── Header ───────────────────────────────────────────────────────────────
    doc
      .fontSize(22)
      .font('Helvetica-Bold')
      .text('Gym Membership Invoice', { align: 'center' });

    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(1);

    // ── Helper ───────────────────────────────────────────────────────────────
    const row = (label, value) => {
      doc.fontSize(12).font('Helvetica-Bold').text(`${label}: `, { continued: true });
      doc.font('Helvetica').text(String(value ?? 'N/A'));
    };

    // ── Invoice metadata ─────────────────────────────────────────────────────
    row('Invoice ID',        `#${renewal.id}`);
    row('Payment Reference', renewal.razorpay_payment_link_id ?? 'N/A');
    doc.moveDown(0.5);

    // ── Gym & member ─────────────────────────────────────────────────────────
    row('Gym Name',    gym.name);
    row('Member Name', member.name);
    row('Phone',       member.phone);
    doc.moveDown(0.5);

    // ── Plan details ─────────────────────────────────────────────────────────
    row('Plan Name',     member.plan_name);
    row('Plan Amount',   `Rs. ${Number(renewal.amount).toFixed(2)}`);
    row('Plan Duration', `${renewal.plan_duration_days} days`);
    doc.moveDown(0.5);

    // ── Dates ────────────────────────────────────────────────────────────────
    const fmt = (d) =>
      new Date(d).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });

    row('Payment Date',    fmt(new Date()));
    row('New Expiry Date', fmt(newExpiry));

    // ── Footer ───────────────────────────────────────────────────────────────
    doc.moveDown(3);
    doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor('grey')
      .text(
        'Thank you for your payment. This is a computer-generated invoice.',
        { align: 'center' }
      );

    doc.end();

    stream.on('finish', () => {
      logger.debug(`[invoiceService] Invoice generated: ${filePath}`);
      resolve(filePath);
    });
    stream.on('error', reject);
  });
}

module.exports = { generateInvoicePDF };
