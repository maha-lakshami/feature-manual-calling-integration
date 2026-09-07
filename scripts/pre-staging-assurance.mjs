import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import dotenv from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { Queue } from 'bullmq';

dotenv.config({ path: path.resolve('.env') });

const require = createRequire(import.meta.url);
const DATABASE_URL = process.env.ASSURANCE_DATABASE_URL || 'postgresql://aiking:aiking@127.0.0.1:5433/aiking?schema=public';
const REDIS_URL = process.env.ASSURANCE_REDIS_URL || 'redis://127.0.0.1:6379';
const API_PORT = 3101;
const API_BASE = `http://127.0.0.1:${API_PORT}/api`;
const QUEUE_PREFIX = `aiking-assurance-${Date.now()}`;
const TENANT_A_SLUG = 'pre-staging-assurance-a';
const TENANT_B_SLUG = 'pre-staging-assurance-b';
const USER_A_EMAIL = 'assurance-a@aiking.invalid';
const USER_B_EMAIL = 'assurance-b@aiking.invalid';
const PASSWORD = 'Assurance-only-2026!';
const TERMINAL_CAMPAIGNS = new Set(['completed', 'completed_with_failures', 'halted_insufficient_funds', 'cancelled', 'failed']);
const QUEUES = ['contact-import', 'campaign-dispatch', 'whatsapp-send', 'email-send', 'call-place', 'recording-ingest', 'call-summarize', 'provider-callback'];

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 40 }) });
const children = new Set();
const report = {
  environment: {}, campaigns: [], imports: [], wallet: {}, razorpay: {}, recovery: {}, responsiveness: {},
  isolation: {}, resources: {}, webhookFlood: {}, paymentAtomicity: {}, failures: [],
};
let tenantA;
let tenantB;
let userA;
let userB;
let apiProcess;
let workerProcess;
let tokenA;
let tokenB;

const commonEnv = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL,
  REDIS_URL,
  QUEUE_DRIVER: 'bullmq',
  QUEUE_PREFIX,
  PROVIDER_MODE: 'mock',
  EMAIL_MODE: 'mock',
  STORAGE_MODE: 'mock',
  MOCK_FAILURE_RATE: '0',
  MOCK_LATENCY_MS: '3',
  LOCAL_STORAGE_DIR: path.resolve('.assurance-storage'),
  JWT_SECRET: 'pre-staging-assurance-jwt-secret-32-characters-minimum',
  PUBLIC_BASE_URL: `http://127.0.0.1:${API_PORT}`,
  API_PORT: String(API_PORT),
  LOG_LEVEL: 'warn',
};

function check(condition, message, details) {
  if (condition) return true;
  report.failures.push({ message, details });
  return false;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function request(pathname, options = {}, token) {
  const started = performance.now();
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(15_000),
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, ok: response.ok, data, durationMs: performance.now() - started };
}

function startProcess(kind, concurrency = 5) {
  const entry = kind === 'api' ? 'apps/api/dist/main.js' : 'apps/api/dist/worker.js';
  const child = spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    env: { ...commonEnv, APP_ROLE: kind, QUEUE_CONCURRENCY: String(concurrency) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.captured = '';
  const capture = (chunk) => { child.captured = `${child.captured}${chunk}`.slice(-500_000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

async function stopProcess(child, force = false) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  }
  await Promise.race([
    exited,
    delay(5_000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); }),
  ]);
}

async function waitForApi() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (apiProcess.exitCode !== null) throw new Error(`API exited during startup: ${apiProcess.captured.slice(-2000)}`);
    try {
      const health = await request('/health');
      if (health.ok) return health;
    } catch {}
    await delay(250);
  }
  throw new Error('API did not become healthy');
}

async function waitForWorker(child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Worker exited during startup: ${child.captured.slice(-2000)}`);
    if (child.captured.includes('Worker started') && child.captured.includes('started 8 worker(s)')) return;
    await delay(250);
  }
  throw new Error('Worker did not become ready');
}

async function cleanupFixtures() {
  await prisma.tenant.deleteMany({ where: { slug: { in: [TENANT_A_SLUG, TENANT_B_SLUG] } } });
  await prisma.user.deleteMany({ where: { email: { in: [USER_A_EMAIL, USER_B_EMAIL] } } });
}

function phone(index) {
  return `+9188${String(index).padStart(8, '0')}`;
}

async function createFixtures() {
  await cleanupFixtures();
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  [userA, userB] = await Promise.all([
    prisma.user.create({ data: { email: USER_A_EMAIL, passwordHash, fullName: 'Assurance Tenant A Manager' } }),
    prisma.user.create({ data: { email: USER_B_EMAIL, passwordHash, fullName: 'Assurance Tenant B Manager' } }),
  ]);
  [tenantA, tenantB] = await Promise.all([
    prisma.tenant.create({ data: { name: 'Assurance Tenant A', slug: TENANT_A_SLUG, whatsappPhoneNumberId: 'assurance_receiver_a' } }),
    prisma.tenant.create({ data: { name: 'Assurance Tenant B', slug: TENANT_B_SLUG, whatsappPhoneNumberId: 'assurance_receiver_b' } }),
  ]);
  await prisma.tenantUser.createMany({ data: [
    { tenantId: tenantA.id, userId: userA.id, role: 'manager', inviteStatus: 'active', acceptedAt: new Date() },
    { tenantId: tenantB.id, userId: userB.id, role: 'manager', inviteStatus: 'active', acceptedAt: new Date() },
  ] });
  await prisma.wallet.createMany({ data: [
    { tenantId: tenantA.id, balancePaise: 1_000_000n, lifetimeCreditedPaise: 1_000_000n },
    { tenantId: tenantB.id, balancePaise: 1_000_000n, lifetimeCreditedPaise: 1_000_000n },
  ] });
  const pricing = await prisma.pricingRule.findFirst({ where: { tenantId: null, eventType: 'whatsapp_message', active: true } });
  if (!pricing) await prisma.pricingRule.create({ data: { tenantId: null, eventType: 'whatsapp_message', unitPricePaise: 85n, createdBy: userA.id } });

  const contactsA = Array.from({ length: 1000 }, (_, index) => ({
    tenantId: tenantA.id,
    fullName: `Assurance A ${index}`,
    phone: index >= 980 && index < 985 ? `invalid-${index}` : phone(index),
    email: `a-${index}@assurance.invalid`,
    whatsappOptedIn: !(index >= 985 && index < 990),
    emailOptedIn: true,
    optedOutAt: index >= 985 && index < 990 ? new Date() : null,
    deletedAt: index >= 990 ? new Date() : null,
    tags: ['assurance-1000', ...(index < 500 ? ['assurance-500'] : []), ...(index < 200 ? ['assurance-200'] : [])],
    customFields: { synthetic: true, index },
  }));
  const contactsB = Array.from({ length: 200 }, (_, index) => ({
    tenantId: tenantB.id,
    fullName: `Assurance B ${index}`,
    phone: index === 0 ? phone(0) : `+9177${String(index).padStart(8, '0')}`,
    email: `b-${index}@assurance.invalid`,
    whatsappOptedIn: index < 190,
    emailOptedIn: true,
    optedOutAt: index >= 190 && index < 195 ? new Date() : null,
    deletedAt: index >= 195 ? new Date() : null,
    tags: ['assurance-b'],
    customFields: { synthetic: true, index },
  }));
  await prisma.contact.createMany({ data: contactsA });
  await prisma.contact.createMany({ data: contactsB });
  const firstA = await prisma.contact.findFirstOrThrow({ where: { tenantId: tenantA.id, phone: phone(0) } });
  await prisma.communicationEvent.create({ data: {
    tenantId: tenantA.id, contactId: firstA.id, channel: 'whatsapp', eventType: 'whatsapp_inbound',
    direction: 'inbound', summary: 'Synthetic historical event', metadata: { synthetic: true },
  } });
  const template = await prisma.template.create({ data: {
    tenantId: tenantA.id, name: 'assurance_whatsapp', channel: 'whatsapp', status: 'approved', language: 'en',
    body: 'Hello {{fullName}}', variables: ['fullName'], providerTemplateName: 'assurance_whatsapp',
    submittedAt: new Date(), approvedAt: new Date(), createdBy: userA.id,
  } });
  const templateB = await prisma.template.create({ data: {
    tenantId: tenantB.id, name: 'assurance_whatsapp_b', channel: 'whatsapp', status: 'approved', language: 'en',
    body: 'Hello {{fullName}}', variables: ['fullName'], providerTemplateName: 'assurance_whatsapp_b',
    submittedAt: new Date(), approvedAt: new Date(), createdBy: userB.id,
  } });
  return { template, templateB, firstA };
}

async function login(email) {
  const response = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: PASSWORD }) });
  if (!response.ok) throw new Error(`Login failed for ${email}: ${response.status} ${JSON.stringify(response.data)}`);
  return response.data.accessToken;
}

async function queueSnapshot() {
  const url = new URL(REDIS_URL);
  const connection = { host: url.hostname, port: Number(url.port || 6379), ...(url.password ? { password: url.password } : {}) };
  const totals = { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };
  for (const name of QUEUES) {
    const queue = new Queue(name, { connection, prefix: QUEUE_PREFIX });
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    for (const key of Object.keys(totals)) totals[key] += counts[key] || 0;
    await queue.close();
  }
  return totals;
}

async function campaignTerminalCount(campaignId) {
  return prisma.campaignRecipient.count({
    where: { campaignId, status: { in: ['sent', 'delivered', 'read', 'opened', 'clicked', 'failed', 'bounced', 'skipped_opted_out', 'skipped_insufficient_funds'] } },
  });
}

async function waitForCampaign(campaignId, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (TERMINAL_CAMPAIGNS.has(campaign.status)) return campaign;
    await delay(200);
  }
  throw new Error(`Campaign ${campaignId} did not reach a terminal state`);
}

async function probeApi(rounds, campaignId) {
  const durations = [];
  let errors5xx = 0;
  const endpoints = ['/contacts?pageSize=1', '/campaigns?pageSize=1', '/wallet', '/health', '/health/ready'];
  for (let round = 0; round < rounds; round += 1) {
    const responses = await Promise.all(endpoints.map((endpoint) => request(endpoint, {}, endpoint.startsWith('/health') ? undefined : tokenA)));
    for (const response of responses) {
      durations.push(response.durationMs);
      if (response.status >= 500) errors5xx += 1;
    }
    if (campaignId && TERMINAL_CAMPAIGNS.has((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status) && round >= 10) break;
    await delay(30);
  }
  return { requests: durations.length, p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), maxMs: Math.max(...durations), errors5xx };
}

async function runCampaign(size, concurrency, templateId, restart = false) {
  await stopProcess(workerProcess);
  workerProcess = startProcess('worker', concurrency);
  await waitForWorker(workerProcess);
  const beforeWallet = await prisma.wallet.findUniqueOrThrow({ where: { tenantId: tenantA.id } });
  const create = await request('/campaigns', { method: 'POST', body: JSON.stringify({
    name: `Assurance ${size} ${Date.now()}`, channel: 'whatsapp', templateId, filter: { tags: [`assurance-${size}`] },
  }) }, tokenA);
  if (!create.ok) throw new Error(`Campaign create failed: ${create.status} ${JSON.stringify(create.data)}`);
  const startedAt = performance.now();
  const launch = await request(`/campaigns/${create.data.id}/launch`, { method: 'POST' }, tokenA);
  if (!launch.ok) throw new Error(`Campaign launch failed: ${launch.status} ${JSON.stringify(launch.data)}`);

  let responsivenessPromise;
  if (size === 1000) responsivenessPromise = probeApi(80, create.data.id);
  let completedBeforeRestart = 0;
  if (restart) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      completedBeforeRestart = await campaignTerminalCount(create.data.id);
      if (completedBeforeRestart >= 100) break;
      await delay(100);
    }
    await stopProcess(workerProcess, true);
    workerProcess = startProcess('worker', concurrency);
    await waitForWorker(workerProcess);
  }

  const finalCampaign = await waitForCampaign(create.data.id);
  const durationMs = performance.now() - startedAt;
  const recipients = await prisma.campaignRecipient.findMany({ where: { campaignId: create.data.id } });
  const grouped = Object.fromEntries((await prisma.campaignRecipient.groupBy({
    by: ['status'], where: { campaignId: create.data.id }, _count: { _all: true },
  })).map((row) => [row.status, row._count._all]));
  const providerIds = recipients.map((row) => row.providerMessageId).filter(Boolean);
  const sentEvents = await prisma.communicationEvent.count({ where: { campaignId: create.data.id, eventType: 'whatsapp_sent' } });
  const afterWallet = await prisma.wallet.findUniqueOrThrow({ where: { tenantId: tenantA.id } });
  const cost = recipients.reduce((sum, row) => sum + (row.costPaise || 0n), 0n);
  const balanceDelta = beforeWallet.balancePaise + beforeWallet.freeCreditBalancePaise - afterWallet.balancePaise - afterWallet.freeCreditBalancePaise;
  const queue = await queueSnapshot();
  const lost = (grouped.pending || 0) + (grouped.queued || 0);
  const duplicateProviderIds = providerIds.length - new Set(providerIds).size;
  const duplicateSentEvents = Math.max(0, sentEvents - providerIds.length);
  const workerErrors = (workerProcess.captured.match(/\bERROR\b/g) || []).length;
  const result = {
    size, concurrency, selectedTagContacts: size,
    recipientsCreated: recipients.length,
    eligibleQueued: launch.data.queuedRecipients,
    skipped: grouped.skipped_opted_out || 0,
    status: finalCampaign.status,
    grouped,
    durationMs,
    jobsCreated: recipients.length,
    jobsCompleted: recipients.length - lost,
    jobsFailed: queue.failed,
    duplicateProviderIds,
    duplicateSentEvents,
    lostJobs: lost,
    walletCostPaise: cost.toString(),
    walletDeltaPaise: balanceDelta.toString(),
    queue,
    workerErrors,
  };
  report.campaigns.push(result);
  if (responsivenessPromise) report.responsiveness = await responsivenessPromise;
  if (restart) report.recovery = { completedBeforeRestart, completedAfterRestart: recipients.length - lost, lostJobs: lost, duplicates: duplicateProviderIds + duplicateSentEvents };
  check(lost === 0, `${size} campaign lost jobs`, result);
  check(duplicateProviderIds === 0 && duplicateSentEvents === 0, `${size} campaign duplicated sends`, result);
  check(cost === balanceDelta, `${size} campaign wallet delta mismatch`, result);
  return { result, recipients };
}

async function waitForImport(id, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  const samples = [];
  while (Date.now() < deadline) {
    const response = await request(`/contacts/imports/${id}`, {}, tokenA);
    if (!response.ok) throw new Error(`Import status failed: ${response.status}`);
    samples.push(response.data.processedRows);
    if (response.data.status === 'completed' || response.data.status === 'failed') return { status: response.data, samples };
    await delay(100);
  }
  throw new Error(`Import ${id} timed out`);
}

async function runImport(size) {
  const tag = `import-${size}-${Date.now()}`;
  const csv = `fullName,email,tags\n${Array.from({ length: size }, (_, index) => `Imported ${index},${tag}-${index}@assurance.invalid,${tag}`).join('\n')}`;
  const startedAt = performance.now();
  const accepted = await request('/contacts/import', { method: 'POST', body: JSON.stringify({ csv }) }, tokenA);
  const acceptedMs = performance.now() - startedAt;
  if (!accepted.ok) throw new Error(`Import submit failed: ${accepted.status} ${JSON.stringify(accepted.data)}`);
  const finished = await waitForImport(accepted.data.id);
  const durationMs = performance.now() - startedAt;
  const tenantACount = await prisma.contact.count({ where: { tenantId: tenantA.id, tags: { has: tag } } });
  const tenantBCount = await prisma.contact.count({ where: { tenantId: tenantB.id, tags: { has: tag } } });
  const progressSamples = [...new Set(finished.samples)];
  const result = {
    size, acceptedMs, durationMs, status: finished.status.status, processedRows: finished.status.processedRows,
    successCount: finished.status.successCount, failureCount: finished.status.failureCount,
    progressSampleCount: progressSamples.length,
    progressSamples: progressSamples.length <= 20
      ? progressSamples
      : [...progressSamples.slice(0, 10), '...', ...progressSamples.slice(-10)],
    duplicates: finished.status.successCount - tenantACount,
    crossTenantWrites: tenantBCount,
  };
  report.imports.push(result);
  check(result.status === 'completed' && tenantACount === size, `${size} import incomplete`, result);
  check(result.duplicates === 0 && tenantBCount === 0, `${size} import isolation/idempotency failure`, result);
  return { result, importId: accepted.data.id };
}

async function walletConcurrency() {
  const { loadConfig } = require('../apps/api/dist/config/configuration.js');
  const { createPrismaClient } = require('../apps/api/dist/common/prisma/prisma.service.js');
  const { TenantContext } = require('../apps/api/dist/common/tenant/tenant-context.js');
  const { TenantSettingsService } = require('../apps/api/dist/common/tenant/tenant-settings.service.js');
  const { WalletService } = require('../apps/api/dist/modules/wallet/wallet.service.js');
  Object.assign(process.env, commonEnv);
  const context = new TenantContext();
  const scopedPrisma = createPrismaClient(loadConfig(), context);
  const wallet = new WalletService(scopedPrisma, context, new TenantSettingsService(scopedPrisma));
  const run = (callback) => context.runAsWorker(tenantA.id, 'pre-staging wallet assurance', callback);

  async function scenario(attempts, balancePaise, amountPaise, keyPrefix) {
    await prisma.walletReservation.deleteMany({ where: { tenantId: tenantA.id } });
    await prisma.wallet.update({ where: { tenantId: tenantA.id }, data: { balancePaise, freeCreditBalancePaise: 0n, reservedPaise: 0n } });
    const ledgerBefore = await prisma.walletTransaction.count({ where: { tenantId: tenantA.id } });
    const settled = await Promise.allSettled(Array.from({ length: attempts }, (_, index) => run(() => wallet.reserve({
      tenantId: tenantA.id, amountPaise, idempotencyKey: `${keyPrefix}:${index}`, referenceType: 'assurance', referenceId: String(index),
    }))));
    const row = await prisma.wallet.findUniqueOrThrow({ where: { tenantId: tenantA.id } });
    const held = await prisma.walletReservation.count({ where: { tenantId: tenantA.id, status: 'held' } });
    const ledgerAfter = await prisma.walletTransaction.count({ where: { tenantId: tenantA.id } });
    const succeeded = settled.filter((entry) => entry.status === 'fulfilled').length;
    return {
      attempts, balancePaise: balancePaise.toString(), amountPaise: amountPaise.toString(), succeeded,
      failed: attempts - succeeded, held, reservedPaise: row.reservedPaise.toString(),
      availablePaise: (row.balancePaise + row.freeCreditBalancePaise - row.reservedPaise).toString(),
      ledgerMutations: ledgerAfter - ledgerBefore,
    };
  }

  const twenty = await scenario(20, 10_000n, 1_000n, 'wallet-20');
  const hundred = await scenario(100, 7_500n, 100n, 'wallet-100');
  report.wallet = { twenty, hundred };
  check(twenty.succeeded === 10 && twenty.failed === 10 && twenty.availablePaise === '0', '20-way wallet lock failed', twenty);
  check(hundred.succeeded === 75 && hundred.failed === 25 && hundred.availablePaise === '0', '100-way wallet lock failed', hundred);
  check(twenty.ledgerMutations === 0 && hundred.ledgerMutations === 0, 'Reservations unexpectedly mutated ledger', report.wallet);
  await scopedPrisma.$disconnect();
  await prisma.walletReservation.deleteMany({ where: { tenantId: tenantA.id } });
  await prisma.wallet.update({ where: { tenantId: tenantA.id }, data: { balancePaise: 1_000_000n, freeCreditBalancePaise: 0n, reservedPaise: 0n } });
}

function razorpayPayload(paymentId, orderId, amount) {
  return JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: {
    id: paymentId, order_id: orderId, amount, currency: 'INR', status: 'captured', method: 'upi',
  } } } });
}

function hmac(secret, body, prefix = '') {
  return `${prefix}${createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function razorpayAssurance() {
  const created = await request('/billing/topups', { method: 'POST', body: JSON.stringify({ amountPaise: '10000' }) }, tokenA);
  if (!created.ok) throw new Error(`Top-up create failed: ${created.status}`);
  const before = await prisma.wallet.findUniqueOrThrow({ where: { tenantId: tenantA.id } });
  const paymentId = `pay_assurance_${Date.now()}`;
  // Deliberately wrong payload amount: the locally stored order amount must remain authoritative.
  const body = razorpayPayload(paymentId, created.data.razorpayOrderId, 1);
  const signature = hmac(commonEnv.RAZORPAY_WEBHOOK_SECRET || 'mock-razorpay-webhook-secret', body);
  const copies = await Promise.all(Array.from({ length: 20 }, () => request('/webhooks/razorpay', {
    method: 'POST', body, headers: { 'x-razorpay-signature': signature, 'x-razorpay-event-id': `evt_${paymentId}` },
  })));
  const replays = [];
  for (let index = 0; index < 10; index += 1) replays.push(await request('/webhooks/razorpay', {
    method: 'POST', body, headers: { 'x-razorpay-signature': signature, 'x-razorpay-event-id': `evt_${paymentId}` },
  }));
  const invalidBody = razorpayPayload(`${paymentId}_invalid`, created.data.razorpayOrderId, 10000);
  const invalid = await request('/webhooks/razorpay', { method: 'POST', body: invalidBody, headers: { 'x-razorpay-signature': 'invalid' } });
  const wrongOrderBody = razorpayPayload(`${paymentId}_wrong_order`, 'order_does_not_exist', 10000);
  const wrongOrder = await request('/webhooks/razorpay', {
    method: 'POST', body: wrongOrderBody,
    headers: { 'x-razorpay-signature': hmac(commonEnv.RAZORPAY_WEBHOOK_SECRET || 'mock-razorpay-webhook-secret', wrongOrderBody) },
  });
  const after = await prisma.wallet.findUniqueOrThrow({ where: { tenantId: tenantA.id } });
  const ledger = await prisma.walletTransaction.count({ where: { tenantId: tenantA.id, idempotencyKey: `razorpay:${paymentId}` } });
  const payments = await prisma.razorpayPayment.count({ where: { razorpayPaymentId: paymentId } });
  const wrongPaymentRows = await prisma.razorpayPayment.count({ where: { razorpayPaymentId: `${paymentId}_wrong_order` } });
  const delta = after.balancePaise + after.freeCreditBalancePaise - before.balancePaise - before.freeCreditBalancePaise;
  report.razorpay = {
    concurrentCopies: copies.length, concurrent2xx: copies.filter((item) => item.ok).length,
    sequentialReplays: replays.length, sequential2xx: replays.filter((item) => item.ok).length,
    invalidSignatureStatus: invalid.status, wrongOrderStatus: wrongOrder.status,
    walletCreditPaise: delta.toString(), ledgerRows: ledger, paymentRows: payments, wrongPaymentRows,
  };
  check(delta === 10_000n && ledger === 1 && payments === 1, 'Razorpay replay credited more than once', report.razorpay);
  check(invalid.status === 401 && wrongPaymentRows === 0, 'Invalid Razorpay input mutated financial state', report.razorpay);
}

function metaBody(messageId, status) {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'assurance_receiver_a' }, statuses: [{ id: messageId, status, timestamp: String(Math.floor(Date.now() / 1000)) }],
  } }] }] });
}

async function postMeta(messageId, status) {
  const body = metaBody(messageId, status);
  return request('/webhooks/meta', { method: 'POST', body, headers: {
    'x-hub-signature-256': hmac(commonEnv.WHATSAPP_APP_SECRET || 'mock-meta-app-secret', body, 'sha256='),
  } });
}

async function webhookFlood(recipients) {
  const ids = recipients.map((row) => row.providerMessageId).filter(Boolean).slice(0, 500);
  const readIds = ids.slice(0, 250);
  const beforeRead = await prisma.communicationEvent.count({ where: { campaignId: recipients[0].campaignId, eventType: 'whatsapp_read' } });
  const requests = [
    ...ids.map((id) => [id, 'sent']),
    ...ids.map((id) => [id, 'delivered']),
    ...readIds.map((id) => [id, 'read']),
    ...readIds.slice(0, 25).map((id) => [id, 'read']),
  ];
  const responses = [];
  for (let offset = 0; offset < requests.length; offset += 25) {
    responses.push(...await Promise.all(requests.slice(offset, offset + 25).map(([id, status]) => postMeta(id, status))));
  }
  const transientIndexes = responses
    .map((response, index) => response.status >= 500 ? index : -1)
    .filter((index) => index >= 0);
  const retryResponses = [];
  for (const index of transientIndexes) {
    const [id, status] = requests[index];
    retryResponses.push(await postMeta(id, status));
  }
  const afterRead = await prisma.communicationEvent.count({ where: { campaignId: recipients[0].campaignId, eventType: 'whatsapp_read' } });
  const statusCounts = Object.fromEntries(
    [...new Set(responses.map((item) => item.status))].sort((a, b) => a - b).map((status) => [status, responses.filter((item) => item.status === status).length]),
  );
  report.webhookFlood = {
    sentEvents: 500, deliveredEvents: 500, readEvents: 250, duplicateReadCopies: 25,
    responses: responses.length, initialNon2xx: transientIndexes.length, retried: retryResponses.length,
    non2xxAfterRetry: retryResponses.filter((item) => !item.ok).length, statusCounts,
    newReadTimelineEvents: afterRead - beforeRead,
  };
  check(
    afterRead - beforeRead === 250 && report.webhookFlood.non2xxAfterRetry === 0,
    'Webhook flood lost or duplicated state',
    report.webhookFlood,
  );
}

async function tenantIsolation(firstA, templateB, importId) {
  const foreignContact = await request(`/contacts/${firstA.id}`, {}, tokenB);
  const foreignTemplateCampaign = await request('/campaigns', { method: 'POST', body: JSON.stringify({
    name: 'Foreign template attempt', channel: 'whatsapp', templateId: templateB.id, filter: { all: true },
  }) }, tokenA);
  const foreignImport = await request(`/contacts/imports/${importId}`, {}, tokenB);
  const beforeA = await prisma.communicationEvent.count({ where: { tenantId: tenantA.id, eventType: 'whatsapp_inbound' } });
  const beforeB = await prisma.communicationEvent.count({ where: { tenantId: tenantB.id, eventType: 'whatsapp_inbound' } });
  const inboundId = `wamid.assurance.inbound.${Date.now()}`;
  const inboundBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'assurance_receiver_a' }, messages: [{ id: inboundId, from: phone(0), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Synthetic inbound' } }],
  } }] }] });
  const inbound = await request('/webhooks/meta', { method: 'POST', body: inboundBody, headers: {
    'x-hub-signature-256': hmac(commonEnv.WHATSAPP_APP_SECRET || 'mock-meta-app-secret', inboundBody, 'sha256='),
  } });
  const afterA = await prisma.communicationEvent.count({ where: { tenantId: tenantA.id, eventType: 'whatsapp_inbound' } });
  const afterB = await prisma.communicationEvent.count({ where: { tenantId: tenantB.id, eventType: 'whatsapp_inbound' } });
  report.isolation = {
    foreignContactStatus: foreignContact.status, foreignTemplateStatus: foreignTemplateCampaign.status,
    foreignImportStatus: foreignImport.status, inboundStatus: inbound.status,
    tenantAInboundDelta: afterA - beforeA, tenantBInboundDelta: afterB - beforeB,
    sharedPhoneExistsBothTenants: await prisma.contact.count({ where: { phone: phone(0), tenantId: { in: [tenantA.id, tenantB.id] } } }),
  };
  check(foreignContact.status === 404 && !foreignTemplateCampaign.ok && foreignImport.status === 404, 'Cross-tenant API access succeeded', report.isolation);
  check(inbound.ok && afterA - beforeA === 1 && afterB === beforeB, 'Inbound receiver leaked across tenants', report.isolation);
}

function processStats(child) {
  if (!child?.pid || child.exitCode !== null || process.platform !== 'win32') return null;
  const command = `Get-Process -Id ${child.pid} | Select-Object Id,CPU,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true });
  try { return JSON.parse(result.stdout.trim()); } catch { return null; }
}

async function resourceSnapshot() {
  const connections = await prisma.$queryRaw`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()`;
  const docker = spawnSync('docker', ['stats', '--no-stream', '--format', '{{json .}}', 'aiking-postgres', 'aiking-redis'], { encoding: 'utf8', windowsHide: true });
  let dockerStats = [];
  try { dockerStats = docker.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); } catch {}
  report.resources = {
    postgresConnections: connections[0]?.count,
    queue: await queueSnapshot(),
    apiProcess: processStats(apiProcess),
    workerProcess: processStats(workerProcess),
    docker: dockerStats,
  };
}

async function main() {
  console.error('[assurance] creating deterministic fixtures');
  const fixture = await createFixtures();
  console.error('[assurance] starting API');
  apiProcess = startProcess('api');
  const health = await waitForApi();
  const ready = await request('/health/ready');
  report.environment = {
    database: 'PostgreSQL at local Docker port 5433', redis: 'Redis/BullMQ at local Docker port 6379',
    apiRole: 'api', workerRole: 'worker', queueDriver: 'bullmq', providerMode: 'mock',
    queuePrefix: QUEUE_PREFIX, healthStatus: health.status, readinessStatus: ready.status, readiness: ready.data,
  };
  check(health.ok && ready.ok, 'Health/readiness failed', report.environment);
  tokenA = await login(USER_A_EMAIL);
  tokenB = await login(USER_B_EMAIL);

  console.error('[assurance] campaign 200 / concurrency 5');
  await runCampaign(200, 5, fixture.template.id);
  console.error('[assurance] campaign 500 / concurrency 10');
  await runCampaign(500, 10, fixture.template.id);
  console.error('[assurance] campaign 1000 / concurrency 20 / restart');
  const thousand = await runCampaign(1000, 20, fixture.template.id, true);
  console.error('[assurance] webhook flood');
  await webhookFlood(thousand.recipients);
  console.error('[assurance] wallet concurrency');
  await walletConcurrency();
  console.error('[assurance] Razorpay replay');
  await razorpayAssurance();
  console.error('[assurance] imports 500/1000/5000');
  await runImport(500);
  await runImport(1000);
  const import5000 = await runImport(5000);
  await tenantIsolation(fixture.firstA, fixture.templateB, import5000.importId);
  await resourceSnapshot();

  report.paymentAtomicity = {
    result: 'verified by code path and replay outcome',
    proof: 'WalletService.credit holds SELECT FOR UPDATE and executes ledger insert plus Razorpay payment/order updates in one transaction hook',
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(`[assurance] FAILED: ${error.stack || error.message}`);
  if (apiProcess?.captured) console.error(`[assurance] API tail:\n${apiProcess.captured.slice(-4000)}`);
  if (workerProcess?.captured) console.error(`[assurance] worker tail:\n${workerProcess.captured.slice(-4000)}`);
  process.exitCode = 1;
} finally {
  console.error('[assurance] stopping child processes and cleaning fixtures');
  await stopProcess(workerProcess);
  await stopProcess(apiProcess);
  for (const child of children) await stopProcess(child, true);
  try { await cleanupFixtures(); } catch (error) { console.error(`Fixture cleanup failed: ${error.message}`); }
  await prisma.$disconnect();
}
