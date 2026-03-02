'use strict';

const crypto = require('crypto');

const secret = 'FgCKj0Bzt4YXLgVe1kllDFUa';
const paymentLinkId = 'plink_SM1NmTXbfAHTw5';

const body = JSON.stringify({
  event: 'payment_link.paid',
  payload: {
    payment_link: {
      entity: { id: paymentLinkId }
    }
  }
});

const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

console.log('--- COPY THESE INTO POSTMAN ---');
console.log('x-razorpay-signature:', sig);
console.log('Body:', body);
