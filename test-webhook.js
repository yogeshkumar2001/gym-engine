'use strict';

const crypto = require('crypto');
const http = require('http');

// ── Config ────────────────────────────────────────────────────────────────────
const WEBHOOK_SECRET  = 'secret@250126';
const PAYMENT_LINK_ID = 'plink_SNqbaQvPPtFYFR';
const GYM_ID          = 1;
const PORT            = 4000;
// ─────────────────────────────────────────────────────────────────────────────

const body = JSON.stringify({
  event: 'payment_link.paid',
  payload: {
    payment_link: {
      entity: { id: PAYMENT_LINK_ID },
    },
  },
});

const signature = crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(body)
  .digest('hex');

console.log('Sending webhook...');
console.log('Body   :', body);
console.log('Sig    :', signature);

const options = {
  hostname: 'localhost',
  port: PORT,
  path: `/webhook/razorpay/${GYM_ID}`,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'x-razorpay-signature': signature,
  },
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log('\nStatus  :', res.statusCode);
    console.log('Response:', data);
  });
});

req.on('error', (err) => console.error('Request error:', err.message));
req.write(body);
req.end();
