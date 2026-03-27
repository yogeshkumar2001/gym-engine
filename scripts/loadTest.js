'use strict';

require('dotenv').config();

/**
 * Load Test — 50 gyms × 200 members (10,000 messages)
 *
 * Tests the QueueProcessor pipeline end-to-end:
 *   Phase 1 — Enqueue  : call enqueue() for every member; target < 5s total
 *   Phase 2 — Process  : drain the queue via processNextBatch(); target < 5 min
 *
 * External APIs are stubbed (axios.post + TokenManager.getActiveToken) so the
 * test runs against the real DB without touching Meta or Razorpay.
 *
 * Usage:
 *   node scripts/loadTest.js
 *
 * Prerequisites:
 *   - DATABASE_URL must point to a non-production database.
 *   - All other required env vars should be set (server.js validates them).
 *     For load testing only, dummy values are acceptable:
 *       MASTER_ENCRYPTION_KEY=0000...  JWT_SECRET=test  etc.
 */

// ─── STUBS — patch BEFORE requiring dependent modules ────────────────────────

// Stub axios so processNextBatch never actually calls Meta
const axios = require('axios');
const _origAxiosPost = axios.post;
let stubbedSendCount = 0;
axios.post = async (url) => {
  if (url && url.includes('/messages')) {
    stubbedSendCount++;
    return { data: { messages: [{ id: `sim_wamid_${stubbedSendCount}` }] } };
  }
  return _origAxiosPost.apply(axios, arguments);
};

// Stub TokenManager so getActiveToken never hits the DB or Meta
const TokenManager = require('../src/services/whatsapp/TokenManager');
TokenManager.getActiveToken = async () => ({
  access_token: 'sim_load_test_token',
  expires_at: new Date(Date.now() + 86400 * 1000),
  status: 'active',
});
TokenManager.alertFounder = async (msg) => {
  // eslint-disable-next-line no-console
  console.log(`  [alertFounder stub] ${msg}`);
};

// ─── LOAD REAL MODULES ───────────────────────────────────────────────────────

const prisma         = require('../src/lib/prisma');
const logger         = require('../src/config/logger');
const { enqueue }    = require('../src/services/whatsapp/QueueProcessor');
const { processNextBatch } = require('../src/services/whatsapp/QueueProcessor');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SIM_GYMS        = 50;
const MEMBERS_PER_GYM = 200;
const TOTAL_MEMBERS   = SIM_GYMS * MEMBERS_PER_GYM;
const SIM_PREFIX      = `[LT-${Date.now()}]`;
const TEMPLATE_TYPE   = 'renewal_reminder';

// Targets from the plan
const ENQUEUE_TARGET_MS  = 5_000;        // < 5 s to queue all 10k messages
const PROCESS_TARGET_MS  = 5 * 60_000;  // < 5 min to drain the queue

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const fmt    = (ms) => ms < 2000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
const mb     = (b)  => `${Math.round(b / 1024 / 1024)} MB`;
const pass   = (ok) => ok ? '✓ PASS' : '✗ FAIL';

async function trackPeak(fn) {
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  const ticker = setInterval(() => {
    const cur = process.memoryUsage().heapUsed;
    if (cur > peak) peak = cur;
  }, 50);
  const t0 = Date.now();
  await fn();
  const elapsed = Date.now() - t0;
  clearInterval(ticker);
  return { elapsed, before, peak };
}

// ─── SEED ────────────────────────────────────────────────────────────────────

async function seed() {
  process.stdout.write(`Seeding ${SIM_GYMS} gyms × ${MEMBERS_PER_GYM} members ... `);
  const t0 = Date.now();

  // Create gyms
  const gymPayloads = Array.from({ length: SIM_GYMS }, (_, i) => ({
    name:        `${SIM_PREFIX} Gym ${String(i + 1).padStart(3, '0')}`,
    owner_phone: `+91700${String(i).padStart(7, '0')}`,
    status:      'active',
    whatsapp_status: 'active',
  }));

  const gyms = await prisma.$transaction(
    gymPayloads.map((d) => prisma.gym.create({ data: d }))
  );

  const gymIds = gyms.map((g) => g.id);

  // Create a system WhatsappAccount per gym (needed by processNextBatch)
  await prisma.$transaction(
    gyms.map((g, i) =>
      prisma.whatsappAccount.create({
        data: {
          gym_id:          g.id,
          display_phone:   `+91800${String(i).padStart(7, '0')}`,
          phone_number_id: `sim_pnid_${g.id}`,
          status:          'active',
          fallback_mode:   false,
        },
      })
    )
  );

  // Create members — use createMany for speed
  const expiryDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const memberPayloads = gyms.flatMap((gym, g) =>
    Array.from({ length: MEMBERS_PER_GYM }, (_, m) => ({
      gym_id:      gym.id,
      name:        `LT Member ${g}_${m}`,
      phone:       `+91${9000000000 + g * MEMBERS_PER_GYM + m}`,
      plan_name:   'Monthly',
      plan_amount: 1000,
      join_date:   new Date('2025-01-01'),
      expiry_date: expiryDate,
      status:      'active',
    }))
  );

  await prisma.member.createMany({ data: memberPayloads });

  // Fetch member ids for enqueue phase
  const members = await prisma.member.findMany({
    where: { gym_id: { in: gymIds } },
    select: { id: true, gym_id: true, phone: true },
  });

  console.log(`done in ${fmt(Date.now() - t0)}.`);
  return { gymIds, members };
}

// ─── CLEANUP ─────────────────────────────────────────────────────────────────

async function cleanup(gymIds) {
  process.stdout.write('\nCleaning up ... ');

  // Delete message_queue rows first (no cascade from gym)
  await prisma.messageQueue.deleteMany({ where: { gym_id: { in: gymIds } } });

  // Delete gyms — cascade deletes members, whatsapp_account, etc.
  const { count } = await prisma.gym.deleteMany({
    where: { name: { startsWith: SIM_PREFIX } },
  });

  console.log(`deleted ${count} gyms (cascade → members, whatsapp_accounts, queue rows).`);
}

// ─── PHASE 1 — ENQUEUE ───────────────────────────────────────────────────────

async function phaseEnqueue(members) {
  process.stdout.write(`\nPhase 1 — Enqueue ${TOTAL_MEMBERS.toLocaleString()} messages ... `);

  let queued = 0;
  let skipped = 0;

  const mem = await trackPeak(async () => {
    for (const member of members) {
      const result = await enqueue(
        member.gym_id,
        member.id,
        TEMPLATE_TYPE,
        [member.phone, 'https://rzp.io/sim/load-test'],
        member.phone,
        { trigger_type: 'load_test' }
      );
      if (result.queued) queued++;
      else skipped++;
    }
  });

  const queueDepth = await prisma.messageQueue.count({
    where: { status: 'queued' },
  });

  return { elapsed: mem.elapsed, queued, skipped, queueDepth, peak: mem.peak, before: mem.before };
}

// ─── PHASE 2 — PROCESS ───────────────────────────────────────────────────────

async function phaseProcess() {
  process.stdout.write(`\nPhase 2 — Drain queue via processNextBatch() ... `);

  let batches = 0;
  stubbedSendCount = 0;

  const mem = await trackPeak(async () => {
    let remaining;
    do {
      await processNextBatch();
      batches++;
      remaining = await prisma.messageQueue.count({ where: { status: 'queued' } });
    } while (remaining > 0 && batches < 2000); // safety cap
  });

  const finalSent = await prisma.messageQueue.count({ where: { status: 'sent' } });
  const finalFailed = await prisma.messageQueue.count({ where: { status: { in: ['failed', 'dead'] } } });

  return {
    elapsed: mem.elapsed,
    batches,
    stub_sends: stubbedSendCount,
    final_sent: finalSent,
    final_failed: finalFailed,
    peak: mem.peak,
    before: mem.before,
  };
}

// ─── REPORT ──────────────────────────────────────────────────────────────────

function printReport(enqueueResult, processResult) {
  const W = 68;
  const line  = '─'.repeat(W);
  const dline = '═'.repeat(W);

  console.log(`\n${dline}`);
  console.log(` LOAD TEST RESULTS — ${SIM_GYMS} gyms × ${MEMBERS_PER_GYM} members`);
  console.log(`                     ${TOTAL_MEMBERS.toLocaleString()} total messages`);
  console.log(dline);

  // Enqueue phase
  console.log(`\n${line}`);
  console.log(` Phase 1 — Enqueue`);
  console.log(line);
  console.log(` Duration:    ${fmt(enqueueResult.elapsed).padEnd(10)} target < ${fmt(ENQUEUE_TARGET_MS)}   ${pass(enqueueResult.elapsed < ENQUEUE_TARGET_MS)}`);
  console.log(` Throughput:  ${Math.round(TOTAL_MEMBERS / (enqueueResult.elapsed / 1000)).toLocaleString()} msg/s`);
  console.log(` Queued:      ${enqueueResult.queued.toLocaleString()} (skipped: ${enqueueResult.skipped})`);
  console.log(` Queue depth: ${enqueueResult.queueDepth.toLocaleString()} rows`);
  console.log(` Memory:      ${mb(enqueueResult.before)} → peak ${mb(enqueueResult.peak)}`);

  // Process phase
  console.log(`\n${line}`);
  console.log(` Phase 2 — Process (stubbed Meta API)`);
  console.log(line);
  console.log(` Duration:    ${fmt(processResult.elapsed).padEnd(10)} target < ${fmt(PROCESS_TARGET_MS)} ${pass(processResult.elapsed < PROCESS_TARGET_MS)}`);
  console.log(` Batches:     ${processResult.batches}  (10 msgs/batch)`);
  console.log(` Throughput:  ${Math.round(processResult.stub_sends / (processResult.elapsed / 1000)).toLocaleString()} msg/s`);
  console.log(` Sent:        ${processResult.final_sent.toLocaleString()}`);
  console.log(` Failed:      ${processResult.final_failed.toLocaleString()}`);
  console.log(` Memory:      ${mb(processResult.before)} → peak ${mb(processResult.peak)}`);

  // Production projection
  const dbOverheadPerMsg = processResult.elapsed / processResult.stub_sends;
  const typMetaMs = 300;
  const msPerMsgProd = dbOverheadPerMsg + typMetaMs;
  const msPerBatchProd = 10 * msPerMsgProd;

  console.log(`\n${line}`);
  console.log(` PRODUCTION ESTIMATE  (300ms Meta API latency)`);
  console.log(line);
  console.log(` DB overhead/msg:  ${dbOverheadPerMsg.toFixed(1)}ms`);
  console.log(` Expected batch:   ~${fmt(Math.round(msPerBatchProd))} / 10-msg batch`);
  const msFor10k = 1000 * msPerBatchProd;  // 10k msgs / 10 per batch = 1000 batches
  console.log(` 10,000 msg drain: ~${fmt(Math.round(msFor10k))}  (at 30s cron cadence → ~${Math.ceil(msFor10k / 30_000)} ticks)`);

  const circuitMsg = processResult.final_failed > 5
    ? '⚠ High failure count — check circuit breaker logic'
    : '✓ Failure count within expected range';
  console.log(`\n ${circuitMsg}`);
  console.log(`\n${dline}\n`);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const W = 68;
  console.log('═'.repeat(W));
  console.log(` LOAD TEST — QueueProcessor pipeline`);
  console.log(` ${SIM_GYMS} gyms × ${MEMBERS_PER_GYM} members = ${TOTAL_MEMBERS.toLocaleString()} messages`);
  console.log(` Node ${process.version}   pid ${process.pid}   ${new Date().toISOString()}`);
  console.log(` NOTE: Meta API stubbed — tests DB throughput, not actual sending`);
  console.log('═'.repeat(W));

  // Silence normal app logs so output stays clean
  logger.silent = true;

  await prisma.$connect();

  let gymIds = [];
  let enqueueResult, processResult;

  try {
    console.log('');
    const { gymIds: ids, members } = await seed();
    gymIds = ids;

    enqueueResult = await phaseEnqueue(members);
    console.log(`done in ${fmt(enqueueResult.elapsed)}.`);

    processResult = await phaseProcess();
    console.log(`done in ${fmt(processResult.elapsed)}.`);

    printReport(enqueueResult, processResult);

  } finally {
    logger.silent = false;
    if (gymIds.length > 0) await cleanup(gymIds);
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`\nLoad test failed: ${err.message}`);
  console.error(err.stack);
  prisma.$disconnect().finally(() => process.exit(1));
});
