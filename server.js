'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const logger = require('./src/config/logger');
const prisma = require('./src/lib/prisma');
const routes = require('./src/routes');
const syncRoutes = require('./src/routes/syncRoutes');
const renewalRoutes = require('./src/routes/renewalRoutes');
const webhookRoutes = require('./src/routes/webhook.routes');
const { initExpiryCron } = require('./src/cron/expiryCron');
const { initSummaryCron } = require('./src/cron/summaryCron');

const app = express();
const PORT = process.env.PORT || 5000;
console.log(process.env.PORT)
// ─── Security Headers ────────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(cors());

// ─── Rate Limiting ───────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again after 15 minutes.' },
});
app.use(limiter);

// ─── Webhook Routes (MUST be before express.json) ────────────────────────────
// Razorpay sends raw body — express.raw() is applied per-route inside this router.
// If express.json() ran first it would consume the stream and break HMAC verification.
app.use('/webhook', webhookRoutes);

// ─── Body Parser ─────────────────────────────────────────────────────────────
app.use(express.json());

// ─── HTTP Request Logging ────────────────────────────────────────────────────
app.use(
  morgan('combined', {
    stream: { write: (message) => logger.info(message.trim()) },
  })
);

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/', routes);
app.use('/sync', syncRoutes);
app.use('/trigger-renewal', renewalRoutes);

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found.' });
});

// ─── Global Error Handler ────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error(err.message, { stack: err.stack });

  // Prisma unique constraint violation
  if (err.code === 'P2002') {
    return res.status(409).json({ success: false, message: 'A record with this data already exists.' });
  }

  // Prisma record not found
  if (err.code === 'P2025') {
    return res.status(404).json({ success: false, message: 'Record not found.' });
  }

  res.status(err.status || 500).json({
    success: false,
    message: err.status ? err.message : 'Internal server error.',
  });
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────
async function start() {
  try {
    await prisma.$connect();
    logger.info('Database connected successfully.');

    const server = app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    });

    // ─── Cron Jobs ─────────────────────────────────────────────────────────────
    initExpiryCron();
    initSummaryCron();

    const shutdown = async (signal) => {
      logger.info(`${signal} received. Shutting down gracefully...`);
      server.close(async () => {
        await prisma.$disconnect();
        logger.info('Database disconnected. Server closed.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.error('Failed to start server.', err);
    process.exit(1);
  }
}

start();
