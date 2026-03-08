'use strict';

const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');

const adapter = new PrismaMariaDb({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 5,
  // Remove idle connections after 5 min — before MySQL's wait_timeout closes them.
  // This prevents "pool timeout: active=0 idle=0" caused by stale connections.
  idleTimeout: 300000,
  // Keep at least 1 warm connection so the first request after idle doesn't wait.
  minimumIdle: 1,
  // Give 30s to acquire a connection (up from the default 10s) for slow startup.
  acquireTimeout: 30000,
});

const prisma = new PrismaClient({ adapter });
module.exports = prisma;
