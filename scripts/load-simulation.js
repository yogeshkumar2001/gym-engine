'use strict';

require('dotenv').config();

/**
 * Load simulation — 100 gyms × 5 members
 *
 * Measures real DB + Node.js throughput with external APIs stubbed.
 * Runs two phases:
 *   Phase 1 — 0ms API latency   → isolates pure DB overhead
 *   Phase 2 — 50ms API latency  → validates linear scaling assumption
 *
 * After both phases, projects production estimates at realistic API speeds
 * and calculates the gym-count ceiling before BullMQ becomes necessary.
 *
 * Usage:
 *   node scripts/load-simulation.js
 */

// ─── PATCH EXTERNAL SERVICES ─────────────────────────────────────────────────
// MUST happen before cron modules are required.
// Cron files destructure service exports at require-time; patching the module
// cache objects before those require() calls run means the crons receive stubs.

const razorpayService     = require('../src/services/razorpayService');
const whatsappService     = require('../src/services/whatsappService');
const credentialValidator = require('../src/services/credentialValidator');

// Call counters — reset per phase
const calls = { razorpay: 0, whatsapp: 0, cred: 0 };

// Controlled per phase — 0 in baseline, > 0 in latency phases
let SIM_LATENCY_MS = 0;

const pause = ms => new Promise(r => setTimeout(r, ms));

razorpayService.createPaymentLinkForRenewal = async (_gym, renewal) => {
  calls.razorpay++;
  if (SIM_LATENCY_MS) await pause(SIM_LATENCY_MS);
  return {
    paymentLinkId: `sim_pl_${renewal.id}`,
    shortUrl:      `https://rzp.io/sim/${renewal.id}`,
  };
};

whatsappService.sendRenewalReminder = async (_gym, renewal) => {
  calls.whatsapp++;
  if (SIM_LATENCY_MS) await pause(SIM_LATENCY_MS);
  return { messageId: `sim_wa_${renewal.id}`, status: 'sent' };
};

whatsappService.sendDailySummary = async () => {
  calls.whatsapp++;
  if (SIM_LATENCY_MS) await pause(SIM_LATENCY_MS);
  return { messageId: null };
};

credentialValidator.validateRazorpay = async () => {
  calls.cred++;
  if (SIM_LATENCY_MS) await pause(SIM_LATENCY_MS);
  return { valid: true, error: null };
};

credentialValidator.validateWhatsapp = async () => {
  calls.cred++;
  if (SIM_LATENCY_MS) await pause(SIM_LATENCY_MS);
  return { valid: true, error: null };
};

credentialValidator.validateGoogleSheet = async () => {
  calls.cred++;
  if (SIM_LATENCY_MS) await pause(SIM_LATENCY_MS);
  return { valid: true, error: null };
};

// ─── LOAD CRON MODULES ───────────────────────────────────────────────────────
// Now that the service module cache is patched, requiring the cron modules
// causes their top-level destructuring to pick up the stubs.

const { detectExpiringMembers }    = require('../src/cron/expiryCron');
const { sendDailySummaries }       = require('../src/cron/summaryCron');
const { runCredentialHealthCheck } = require('../src/cron/credentialHealthCron');

// ─── DEPS ────────────────────────────────────────────────────────────────────

const prisma = require('../src/lib/prisma');
const logger = require('../src/config/logger');
const { getTargetDayWindow } = require('../src/utils/dateUtils');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SIM_GYMS        = 100;
const MEMBERS_PER_GYM = 5;
const TOTAL_MEMBERS   = SIM_GYMS * MEMBERS_PER_GYM;
const SIM_PREFIX      = `[SIM-${Date.now()}]`;

const PHASES = [
  { label: 'Phase 1 — DB baseline (0ms latency)',     latencyMs: 0  },
  { label: 'Phase 2 — Linear validation (50ms/call)', latencyMs: 50 },
];

// ─── UTILITIES ───────────────────────────────────────────────────────────────

const fmt = ms => ms < 2000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
const mb  = b  => `${Math.round(b / 1024 / 1024)} MB`;
const pad = (s, n) => String(s).padEnd(n);

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
  return { elapsed, before, peak, after: process.memoryUsage().heapUsed };
}

// ─── SEED ────────────────────────────────────────────────────────────────────

async function seed() {
  const { startOfTargetDay, endOfTargetDay } = getTargetDayWindow(3);
  // Noon UTC of the target day — safely inside both ends of the detection window
  const expiryDate = new Date(
    Math.round((startOfTargetDay.getTime() + endOfTargetDay.getTime()) / 2)
  );

  process.stdout.write(
    `Seeding ${SIM_GYMS} gyms × ${MEMBERS_PER_GYM} members (expiry ${expiryDate.toISOString().slice(0, 10)}) ... `
  );
  const t0 = Date.now();

  const gymPayloads = Array.from({ length: SIM_GYMS }, (_, i) => ({
    name:                     `${SIM_PREFIX} Gym ${String(i + 1).padStart(3, '0')}`,
    // Plaintext values — decrypt() passes them through unchanged (backward-compat path)
    razorpay_key_id:          'sim_rzp_key_id',
    razorpay_key_secret:      'sim_rzp_key_secret',
    razorpay_webhook_secret:  'sim_webhook_secret',
    whatsapp_phone_number_id: 'sim_wa_phone_id',
    whatsapp_access_token:    'sim_wa_token',
    google_sheet_id:          `sim_sheet_${i}`,
    owner_phone:              `+91700000${String(i).padStart(4, '0')}`,
    status:                   'active',
  }));

  // Single transaction: all 100 gym inserts in one round-trip
  const gyms = await prisma.$transaction(
    gymPayloads.map(d => prisma.gym.create({ data: d }))
  );

  // Single query: all 500 member inserts
  const memberPayloads = gyms.flatMap((gym, g) =>
    Array.from({ length: MEMBERS_PER_GYM }, (_, m) => ({
      gym_id:      gym.id,
      name:        `Sim Member ${g}_${m}`,
      // Globally unique phone (avoids gym_id+phone composite unique constraint)
      phone:       `+91${7000000000 + g * MEMBERS_PER_GYM + m}`,
      plan_name:   'Monthly',
      plan_amount: 1000 + m * 200,   // 1000 / 1200 / 1400 / 1600 / 1800
      join_date:   new Date('2025-01-01'),
      expiry_date: expiryDate,
      status:      'active',
    }))
  );

  await prisma.member.createMany({ data: memberPayloads });

  console.log(`done in ${fmt(Date.now() - t0)}.`);
  return gyms.map(g => g.id);
}

// ─── RESET BETWEEN PHASES ────────────────────────────────────────────────────

async function resetForNextPhase(gymIds) {
  // Remove renewals so expiry cron creates them fresh
  await prisma.renewal.deleteMany({ where: { gym_id: { in: gymIds } } });

  // Clear last_reminder_sent_at — if set, the 48h guard would skip these members
  await prisma.member.updateMany({
    where: { gym_id: { in: gymIds } },
    data:  { last_reminder_sent_at: null },
  });

  // Restore gym state in case health cron modified any fields
  await prisma.gym.updateMany({
    where: { id: { in: gymIds } },
    data:  { status: 'active', last_health_check_at: null, last_error_message: null },
  });
}

// ─── CLEANUP ─────────────────────────────────────────────────────────────────

async function cleanup() {
  process.stdout.write('\nCleaning up ... ');
  // Cascade delete — Renewal, Member, Payment are all onDelete: Cascade
  const { count } = await prisma.gym.deleteMany({
    where: { name: { startsWith: SIM_PREFIX } },
  });
  console.log(`deleted ${count} gyms (cascade → members, renewals, payments).`);
}

// ─── VERIFICATION ────────────────────────────────────────────────────────────

async function verifyCounts(gymIds) {
  const [renewalCount, sentCount] = await Promise.all([
    prisma.renewal.count({ where: { gym_id: { in: gymIds } } }),
    prisma.renewal.count({ where: { gym_id: { in: gymIds }, whatsapp_status: 'sent' } }),
  ]);
  return { renewalCount, sentCount };
}

// ─── PHASE RUNNER ────────────────────────────────────────────────────────────

async function runPhase(phase, gymIds) {
  SIM_LATENCY_MS = phase.latencyMs;
  Object.assign(calls, { razorpay: 0, whatsapp: 0, cred: 0 });

  // ── Expiry cron ──
  process.stdout.write('  expiry  ... ');
  const expiry = await trackPeak(detectExpiringMembers);
  const expiryCallSnap = { rzp: calls.razorpay, wa: calls.whatsapp };
  const verify = await verifyCounts(gymIds);
  console.log(fmt(expiry.elapsed));

  // ── Summary cron ──
  Object.assign(calls, { razorpay: 0, whatsapp: 0, cred: 0 });
  process.stdout.write('  summary ... ');
  const summary = await trackPeak(sendDailySummaries);
  const summaryCallSnap = { wa: calls.whatsapp };
  console.log(fmt(summary.elapsed));

  // ── Credential health cron ──
  Object.assign(calls, { razorpay: 0, whatsapp: 0, cred: 0 });
  process.stdout.write('  health  ... ');
  const health = await trackPeak(runCredentialHealthCheck);
  const healthCallSnap = { cred: calls.cred };
  console.log(fmt(health.elapsed));

  return { expiry, expiryCallSnap, verify, summary, summaryCallSnap, health, healthCallSnap };
}

// ─── REPORT ──────────────────────────────────────────────────────────────────

function printReport(phaseResults) {
  const W = 68;
  const line  = '─'.repeat(W);
  const dline = '═'.repeat(W);

  console.log(`\n${dline}`);
  console.log(` RESULTS — ${SIM_GYMS} gyms × ${MEMBERS_PER_GYM} members = ${TOTAL_MEMBERS} total`);
  console.log(dline);

  for (const { phase, r } of phaseResults) {
    const msPerGym    = (r.expiry.elapsed  / SIM_GYMS).toFixed(1);
    const msPerMember = (r.expiry.elapsed  / TOTAL_MEMBERS).toFixed(1);

    console.log(`\n${line}`);
    console.log(` ${phase.label}`);
    console.log(line);

    console.log(
      ` Expiry cron   ${pad(fmt(r.expiry.elapsed), 9)}` +
      `  ${msPerGym}ms/gym  ${msPerMember}ms/member` +
      `  heap: ${mb(r.expiry.before)} → peak ${mb(r.expiry.peak)}`
    );
    console.log(
      `               Razorpay calls: ${r.expiryCallSnap.rzp}  ` +
      `WhatsApp calls: ${r.expiryCallSnap.wa}  ` +
      `Renewals created: ${r.verify.renewalCount}  ` +
      `WA sent: ${r.verify.sentCount}`
    );

    console.log(
      ` Summary cron  ${pad(fmt(r.summary.elapsed), 9)}` +
      `  ${(r.summary.elapsed / SIM_GYMS).toFixed(1)}ms/gym` +
      `  heap: ${mb(r.summary.before)} → peak ${mb(r.summary.peak)}`
    );
    console.log(`               WhatsApp calls: ${r.summaryCallSnap.wa}`);

    console.log(
      ` Health cron   ${pad(fmt(r.health.elapsed), 9)}` +
      `  ${(r.health.elapsed / SIM_GYMS).toFixed(1)}ms/gym` +
      `  heap: ${mb(r.health.before)} → peak ${mb(r.health.peak)}`
    );
    console.log(`               Credential checks: ${r.healthCallSnap.cred}  (3/gym)`);
  }

  // ── Production extrapolation ───────────────────────────────────────────────
  // Use phase 1 (0ms) as the DB overhead baseline.
  const dbPhase      = phaseResults[0].r;
  const dbPerMember  = dbPhase.expiry.elapsed / TOTAL_MEMBERS;  // ms
  const dbPerGym     = dbPhase.expiry.elapsed / SIM_GYMS;       // ms (includes summary batch)

  console.log(`\n${line}`);
  console.log(` PRODUCTION ESTIMATE — Expiry Cron`);
  console.log(` DB overhead: ${dbPerMember.toFixed(1)}ms/member  ${dbPerGym.toFixed(1)}ms/gym`);
  console.log(line);
  console.log(
    ` ${'Scenario'.padEnd(26)} ${'50 gyms'.padStart(9)} ${'100 gyms'.padStart(9)}` +
    ` ${'200 gyms'.padStart(9)} ${'500 gyms'.padStart(9)}`
  );
  console.log(` ${line.slice(0, 64)}`);

  const scenarios = [
    { label: 'Fast APIs   (100ms/call)',  rzp: 100, wa: 100 },
    { label: 'Typical     (300ms/call)',  rzp: 300, wa: 300 },
    { label: 'Slow APIs   (600ms/call)',  rzp: 600, wa: 600 },
  ];

  for (const sc of scenarios) {
    const msPerMemberProd = dbPerMember + sc.rzp + sc.wa;
    const cols = [50, 100, 200, 500].map(n =>
      fmt(Math.round(n * MEMBERS_PER_GYM * msPerMemberProd)).padStart(9)
    );
    console.log(` ${sc.label.padEnd(26)} ${cols.join('')}`);
  }

  // ── Scale ceiling ──────────────────────────────────────────────────────────
  const windowMs      = 60 * 60 * 1000;      // 1-hour cron window
  const typRzp        = 300;
  const typWa         = 300;
  const msPerMemberTy = dbPerMember + typRzp + typWa;
  const maxMembers    = Math.floor(windowMs / msPerMemberTy);
  const maxGyms       = Math.floor(maxMembers / MEMBERS_PER_GYM);

  // Scaling factor check (phase1 vs phase2)
  const scaleFactor = phaseResults.length > 1
    ? (phaseResults[1].r.expiry.elapsed / phaseResults[0].r.expiry.elapsed).toFixed(2)
    : 'n/a';
  const expectedFactor = phaseResults.length > 1
    ? ((PHASES[1].latencyMs * 2 * TOTAL_MEMBERS + phaseResults[0].r.expiry.elapsed) /
        phaseResults[0].r.expiry.elapsed).toFixed(2)
    : 'n/a';

  console.log(`\n${line}`);
  console.log(` SCALE CEILING  (typical 300ms APIs, 5 members/gym, 1h window)`);
  console.log(line);
  console.log(` Max gyms per cron run: ~${maxGyms}`);
  console.log(` Next architectural step above that: BullMQ concurrent job queue`);

  if (phaseResults.length > 1) {
    console.log(`\n LINEAR SCALING CHECK`);
    console.log(` Expected phase2/phase1 ratio: ${expectedFactor}×   Actual: ${scaleFactor}×`);
    const linear = Math.abs(parseFloat(scaleFactor) - parseFloat(expectedFactor)) < 0.15;
    console.log(` Verdict: ${linear ? '✓ Linear — DB overhead is not the bottleneck' : '⚠ Non-linear — investigate DB query time'}`);
  }

  console.log(`\n${dline}\n`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const W = 68;
  console.log('═'.repeat(W));
  console.log(` LOAD SIMULATION`);
  console.log(` ${SIM_GYMS} gyms × ${MEMBERS_PER_GYM} members = ${TOTAL_MEMBERS} total`);
  console.log(` Node ${process.version}   pid ${process.pid}   ${new Date().toISOString()}`);
  console.log('═'.repeat(W));

  // Silence cron logs during simulation — output would be 500+ lines
  logger.silent = true;

  await prisma.$connect();

  let gymIds = [];
  const phaseResults = [];

  try {
    console.log('');
    gymIds = await seed();

    for (const phase of PHASES) {
      console.log(`\n${phase.label}`);
      await resetForNextPhase(gymIds);
      const r = await runPhase(phase, gymIds);
      phaseResults.push({ phase, r });
    }

    printReport(phaseResults);

  } finally {
    logger.silent = false;
    await cleanup();
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error(`\nSimulation failed: ${err.message}`);
  console.error(err.stack);
  prisma.$disconnect().finally(() => process.exit(1));
});
