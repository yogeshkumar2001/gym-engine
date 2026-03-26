'use strict';

const axios = require('axios');
const { Prisma } = require('@prisma/client');
const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');
const TokenManager = require('./TokenManager');
const TemplateManager = require('./TemplateManager');

const GRAPH_API_VERSION = 'v22.0';

/**
 * Parses a "HH:MM" string and returns { hours, minutes }.
 */
function parseTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return { hours: h, minutes: m };
}

/**
 * Returns true if the given Date falls within a quiet window.
 * Handles cross-midnight ranges (e.g. 21:00–08:00).
 */
function isQuietHour(date, quiet_start, quiet_end) {
  const totalMins = date.getHours() * 60 + date.getMinutes();
  const { hours: sh, minutes: sm } = parseTime(quiet_start);
  const { hours: eh, minutes: em } = parseTime(quiet_end);
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;

  if (startMins > endMins) {
    // Cross-midnight: e.g. 21:00–08:00
    return totalMins >= startMins || totalMins < endMins;
  }
  return totalMins >= startMins && totalMins < endMins;
}

/**
 * Advances a Date to quiet_end on the same or next day.
 */
function advanceToQuietEnd(date, quiet_end) {
  const { hours, minutes } = parseTime(quiet_end);
  const advanced = new Date(date);
  advanced.setHours(hours, minutes, 0, 0);
  if (advanced <= date) {
    advanced.setDate(advanced.getDate() + 1);
  }
  return advanced;
}

/**
 * Enqueues a WhatsApp message, with dedup and quiet-hours handling.
 *
 * @param {number} gymId
 * @param {number|null} memberId
 * @param {string} templateType
 * @param {string[]} params
 * @param {string} recipientPhone
 * @param {{ quiet_start?: string, quiet_end?: string, scheduledAt?: Date, trigger_type?: string, trigger_ref?: string }} options
 * @returns {Promise<{ queued: boolean, id?: string, skipped?: boolean }>}
 */
async function enqueue(gymId, memberId, templateType, params, recipientPhone, options = {}) {
  // Dedup: skip if same message sent/queued in last 24h
  if (memberId != null) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const existing = await prisma.messageQueue.findFirst({
      where: {
        gym_id: gymId,
        member_id: memberId,
        template_type: templateType,
        status: { in: ['queued', 'sending', 'sent', 'delivered'] },
        created_at: { gt: cutoff },
      },
    });

    if (existing) {
      logger.debug('[QueueProcessor] enqueue dedup — skipping', {
        gym_id: gymId,
        member_id: memberId,
        template_type: templateType,
        existing_id: existing.id,
      });
      return { queued: false, skipped: true };
    }
  }

  // Quiet hours
  const { quiet_start = '21:00', quiet_end = '08:00' } = options;
  let scheduledAt = options.scheduledAt ? new Date(options.scheduledAt) : new Date();

  if (isQuietHour(scheduledAt, quiet_start, quiet_end)) {
    scheduledAt = advanceToQuietEnd(scheduledAt, quiet_end);
  }

  const row = await prisma.messageQueue.create({
    data: {
      gym_id: gymId,
      member_id: memberId ?? null,
      template_type: templateType,
      template_params: params,
      recipient_phone: recipientPhone,
      scheduled_at: scheduledAt,
      trigger_type: options.trigger_type ?? null,
      trigger_ref: options.trigger_ref ?? null,
    },
  });

  logger.debug('[QueueProcessor] enqueued', {
    id: row.id,
    gym_id: gymId,
    member_id: memberId,
    template_type: templateType,
    scheduled_at: scheduledAt,
  });

  return { queued: true, id: row.id };
}

/**
 * Fetches up to 10 queued messages (FOR UPDATE SKIP LOCKED), marks them
 * 'sending', then sends each one serially via the Meta API.
 */
async function processNextBatch() {
  // Atomically claim up to 10 rows
  const rows = await prisma.$transaction(async (tx) => {
    const selected = await tx.$queryRaw`
      SELECT id, gym_id, template_type, template_params, recipient_phone, attempts, max_attempts
      FROM message_queue
      WHERE status = 'queued' AND scheduled_at <= NOW()
      LIMIT 10
      FOR UPDATE SKIP LOCKED
    `;

    if (selected.length === 0) return [];

    const ids = selected.map((r) => r.id);
    await tx.$executeRaw`
      UPDATE message_queue SET status = 'sending' WHERE id IN (${Prisma.join(ids)})
    `;

    return selected;
  });

  if (rows.length === 0) return;

  let accessToken;
  try {
    const tokenData = await TokenManager.getActiveToken();
    accessToken = tokenData.access_token;
  } catch (err) {
    logger.error('[QueueProcessor] processNextBatch: cannot get token — aborting batch', {
      error: err.message,
    });
    // Reset all 'sending' rows back to 'queued' so they can be retried
    const ids = rows.map((r) => r.id);
    await prisma.$executeRaw`
      UPDATE message_queue SET status = 'queued' WHERE id IN (${Prisma.join(ids)})
    `;
    return;
  }

  // Fetch phone_number_id for each unique gym_id
  const gymIds = [...new Set(rows.map((r) => r.gym_id))];
  const accounts = await prisma.whatsappAccount.findMany({
    where: { gym_id: { in: gymIds }, status: 'active' },
    select: { gym_id: true, phone_number_id: true },
  });
  const phoneMap = Object.fromEntries(accounts.map((a) => [a.gym_id, a.phone_number_id]));

  let sentCount = 0;
  let failedCount = 0;
  const startTime = Date.now();

  for (const row of rows) {
    const phoneNumberId = phoneMap[row.gym_id];
    if (!phoneNumberId) {
      logger.error('[QueueProcessor] no active phone_number_id for gym — marking failed', {
        gym_id: row.gym_id,
        queue_id: row.id,
      });
      await prisma.messageQueue.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          error_code: 'NO_PHONE_NUMBER_ID',
          error_detail: 'No active WhatsappAccount found for gym',
          attempts: row.attempts + 1,
          failed_at: new Date(),
        },
      });
      failedCount++;
      continue;
    }

    try {
      const params = Array.isArray(row.template_params) ? row.template_params : JSON.parse(row.template_params ?? '[]');
      const payload = await TemplateManager.buildMessagePayload(
        row.template_type,
        params,
        row.recipient_phone
      );

      const response = await axios.post(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
        payload,
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
      );

      const wamid = response.data?.messages?.[0]?.id ?? null;

      await prisma.messageQueue.update({
        where: { id: row.id },
        data: { status: 'sent', wamid, sent_at: new Date() },
      });

      sentCount++;
    } catch (err) {
      const statusCode = err.response?.status;
      const errorCode = err.response?.data?.error?.code ?? String(statusCode ?? 'UNKNOWN');
      const errorDetail = err.response?.data?.error?.message ?? err.message;

      const newAttempts = row.attempts + 1;
      const isDead = newAttempts >= row.max_attempts;

      await prisma.messageQueue.update({
        where: { id: row.id },
        data: {
          status: isDead ? 'dead' : 'failed',
          error_code: String(errorCode).slice(0, 20),
          error_detail: errorDetail,
          attempts: newAttempts,
          failed_at: new Date(),
          next_retry_at: isDead ? null : new Date(Date.now() + Math.pow(2, newAttempts) * 30_000),
        },
      });

      failedCount++;

      // Circuit breaker on Meta 430 (rate limit)
      if (statusCode === 430) {
        await circuitBreaker(row.gym_id);
      }
    }
  }

  logger.info('[QueueProcessor] batch complete', {
    batch_size: rows.length,
    sent_count: sentCount,
    failed_count: failedCount,
    duration_ms: Date.now() - startTime,
  });
}

/**
 * Finds failed messages past their next_retry_at and resets them to 'queued'.
 */
async function retryFailed() {
  const rows = await prisma.messageQueue.findMany({
    where: {
      status: 'failed',
      next_retry_at: { lte: new Date() },
      attempts: { lt: prisma.messageQueue.fields?.max_attempts ?? 3 },
    },
    select: { id: true, attempts: true, max_attempts: true },
  });

  if (rows.length === 0) return;

  // Filter out rows that have hit max_attempts (in case of race)
  const eligible = rows.filter((r) => r.attempts < r.max_attempts);
  if (eligible.length === 0) return;

  const ids = eligible.map((r) => r.id);
  await prisma.messageQueue.updateMany({
    where: { id: { in: ids } },
    data: { status: 'queued', next_retry_at: null },
  });

  logger.info('[QueueProcessor] retryFailed reset', { count: ids.length });
}

/**
 * Alerts founder if a gym has 5+ failures in the last hour.
 * Does NOT pause the queue.
 * @param {number} gymId
 */
async function circuitBreaker(gymId) {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  const count = await prisma.messageQueue.count({
    where: { gym_id: gymId, status: 'failed', created_at: { gt: cutoff } },
  });

  if (count >= 5) {
    logger.error('[QueueProcessor] circuit breaker triggered', { gym_id: gymId, failure_count: count });
    try {
      await TokenManager.alertFounder(
        `Gym ${gymId} has ${count} WhatsApp failures in the last hour. Investigate before retrying.`
      );
    } catch (_) {
      // already logged inside alertFounder
    }
  }
}

module.exports = { enqueue, processNextBatch, retryFailed, circuitBreaker };
