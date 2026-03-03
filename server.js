'use strict';

require('dotenv').config();

// ─── Startup environment validation ─────────────────────────────────────────
// Fail fast before any module initialisation if critical secrets are absent.
// verifyAdmin.js also guards ADMIN_API_KEY at module load, but an explicit
// check here surfaces all missing vars in a single error message.
const REQUIRED_ENV = ['DATABASE_URL', 'MASTER_ENCRYPTION_KEY', 'JWT_SECRET', 'ADMIN_API_KEY'];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`[startup] Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

if (!process.env.ALLOWED_ORIGIN) {
  // eslint-disable-next-line no-console
  console.warn('[startup] ALLOWED_ORIGIN is not set — CORS will block all cross-origin requests.');
}

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const logger = require('./src/config/logger');
const prisma = require('./src/lib/prisma');
const routes = require('./src/routes');
const webhookRoutes = require('./src/routes/webhook.routes');
const publicRoutes = require('./src/routes/public.routes');
const ownerRoutes = require('./src/routes/owner.routes');
const adminRoutes = require('./src/routes/admin.routes');
const { initExpiryCron } = require('./src/cron/expiryCron');
const { initSummaryCron } = require('./src/cron/summaryCron');
const { initCredentialHealthCron } = require('./src/cron/credentialHealthCron');

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Security Headers ────────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ────────────────────────────────────────────────────────────────────
// ALLOWED_ORIGIN must be set in production (e.g. "https://app.yourdomain.com").
// If unset, CORS headers are omitted — all cross-origin requests are blocked.
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key'],
}));

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
app.use('/public', publicRoutes);
app.use('/owner', ownerRoutes);
app.use('/admin', adminRoutes);

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
    initExpiryCron();           // 09:00 IST — detect expiring members, create/send renewals
    initSummaryCron();          // 20:00 IST — daily stats WhatsApp to gym owner
    initCredentialHealthCron(); // 00:30 IST — validate Razorpay / WhatsApp / Google Sheet creds

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
