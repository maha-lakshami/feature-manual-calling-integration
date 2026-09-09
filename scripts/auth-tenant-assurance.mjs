import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { Queue } from 'bullmq';
import dotenv from 'dotenv';
import IORedis from 'ioredis';

dotenv.config();

const root = process.cwd();
const runTag = `auth-assurance-${Date.now()}-${randomUUID().slice(0, 6)}`;
const apiPort = 3101;
const apiBase = `http://127.0.0.1:${apiPort}/api`;
const queuePrefix = `aiking-${runTag}`;
const storageDir = path.resolve(root, '.assurance-storage', runTag);
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

if (!databaseUrl) throw new Error('DATABASE_URL is required for the assurance suite');
if (!storageDir.startsWith(path.resolve(root, '.assurance-storage') + path.sep)) {
  throw new Error('Refusing to use an assurance storage directory outside the workspace');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});

const passwords = {
  admin: `Aa7!${randomUUID()}x`,
  managerA: `Aa7!${randomUUID()}x`,
  managerB: `Aa7!${randomUUID()}x`,
  staffA: `Aa7!${randomUUID()}x`,
};
const emails = {
  admin: `${runTag}.admin@example.test`,
  managerA: `${runTag}.manager-a@example.test`,
  managerB: `${runTag}.manager-b@example.test`,
  staffA: `${runTag}.staff-a@example.test`,
};
const slugs = {
  tenantA: `${runTag}-a`,
  tenantB: `${runTag}-b`,
};

const evidence = [];
const failures = [];
const childLogs = new Map();
const children = [];
const openedQueues = [];
let adminUserId;
let tenantAId;
let tenantBId;

function record(area, check, passed, actual, expected) {
  const row = { area, check, passed, actual: String(actual), expected: String(expected) };
  evidence.push(row);
  if (!passed) failures.push(row);
}

function expectStatus(area, check, response, expected) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  record(area, check, allowed.includes(response.status), response.status, allowed.join('/'));
  return response;
}

function expectValue(area, check, actual, expected) {
  record(area, check, Object.is(actual, expected), actual, expected);
}

function expectTruthy(area, check, value, expected = 'truthy') {
  record(area, check, Boolean(value), Boolean(value), expected);
}

function requireSuccessful(response, description) {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${description} failed with HTTP ${response.status}`);
  }
  return response.data;
}

async function request(pathOrUrl, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.cookie) headers.Cookie = options.cookie;
  let body;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers['Content-Type'] ||= options.contentType || 'application/json';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] ||= 'application/json';
  }

  const response = await fetch(pathOrUrl.startsWith('http') ? pathOrUrl : `${apiBase}${pathOrUrl}`, {
    method: options.method || 'GET',
    headers,
    body,
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const cookie = setCookies[0]?.split(';')[0] || null;
  return { status: response.status, data, cookie, setCookie: setCookies[0] || null, headers: response.headers };
}

async function poll(description, probe, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (await predicate(last)) return last;
    } catch {
      // Readiness and asynchronous worker probes may briefly fail while the
      // separate process is starting or transitioning a row.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${description} did not reach its expected state in ${timeoutMs}ms`);
}

function appendChildLog(name, chunk) {
  const previous = childLogs.get(name) || '';
  childLogs.set(name, `${previous}${chunk}`.slice(-12_000));
}

function startProcess(name, entry, env) {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => appendChildLog(name, chunk.toString()));
  child.stderr.on('data', (chunk) => appendChildLog(name, chunk.toString()));
  children.push({ name, child });
  return child;
}

async function stopProcesses() {
  for (const { child } of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  await Promise.all(
    children.map(({ child }) => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        if (!child.killed) child.kill();
        resolve();
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    })),
  );
}

function signJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const unsigned = `${header}.${encodedPayload}`;
  const signature = crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me')
    .update(unsigned)
    .digest('base64url');
  return `${unsigned}.${signature}`;
}

function decodeJwt(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

function signMeta(rawBody) {
  return `sha256=${crypto
    .createHmac('sha256', process.env.WHATSAPP_APP_SECRET || 'mock-meta-app-secret')
    .update(rawBody)
    .digest('hex')}`;
}

function signRazorpay(rawBody) {
  return crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || 'mock-razorpay-webhook-secret')
    .update(rawBody)
    .digest('hex');
}

async function login(email, password, tenantSlug) {
  return request('/auth/login', {
    method: 'POST',
    body: { email, password, ...(tenantSlug ? { tenantSlug } : {}) },
  });
}

async function malformedJob(queueName, payload, resourceCheck) {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(queueName, { connection, prefix: queuePrefix });
  openedQueues.push({ queue, connection });
  const job = await queue.add(queueName, payload, {
    jobId: `${runTag}-${queueName}`,
    attempts: 1,
    removeOnComplete: false,
    removeOnFail: false,
  });
  const finished = await poll(
    `${queueName} mismatched job`,
    async () => {
      const current = await queue.getJob(job.id);
      return current ? { current, state: await current.getState() } : null;
    },
    (value) => value?.state === 'completed' || (value?.state === 'failed' && Boolean(value.current.failedReason)),
  );
  expectValue('worker isolation', `${queueName} mismatched tenant job fails closed`, finished.state, 'failed');
  expectTruthy('worker isolation', `${queueName} failure identifies a missing scoped resource`, finished.current.failedReason?.includes('no longer exists'));
  expectValue('worker isolation', `${queueName} did not mutate Tenant B resource`, await resourceCheck(), true);
  await finished.current.remove();
}

async function cleanup() {
  for (const { queue, connection } of openedQueues) {
    await queue.close().catch(() => undefined);
    connection.disconnect();
  }
  await stopProcesses();

  for (const slug of [slugs.tenantA, slugs.tenantB]) {
    const tenant = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } }).catch(() => null);
    if (tenant) await prisma.tenant.delete({ where: { id: tenant.id } }).catch(() => undefined);
  }
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }).catch(() => undefined);
  const [remainingTenants, remainingUsers] = await Promise.all([
    prisma.tenant.count({ where: { slug: { in: Object.values(slugs) } } }),
    prisma.user.count({ where: { email: { in: Object.values(emails) } } }),
  ]);
  await prisma.$disconnect().catch(() => undefined);
  await fs.rm(storageDir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`ASSURANCE CLEANUP | tenants=${remainingTenants} users=${remainingUsers}`);
}

async function run() {
  await prisma.$connect();
  await fs.mkdir(storageDir, { recursive: true });

  adminUserId = (
    await prisma.user.create({
      data: {
        email: emails.admin,
        fullName: 'Assurance Platform Admin',
        passwordHash: await bcrypt.hash(passwords.admin, 4),
        isSuperAdmin: true,
      },
      select: { id: true },
    })
  ).id;

  const childEnv = {
    ...process.env,
    NODE_ENV: 'development',
    API_PORT: String(apiPort),
    PUBLIC_BASE_URL: `http://127.0.0.1:${apiPort}`,
    PLIVO_CALLBACK_BASE_URL: `http://127.0.0.1:${apiPort}`,
    API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
    APP_ROLE: 'api',
    QUEUE_DRIVER: 'bullmq',
    QUEUE_PREFIX: queuePrefix,
    LOCAL_STORAGE_DIR: storageDir,
    PROVIDER_MODE: 'mock',
    PAYMENTS_MODE: 'mock',
    MOCK_FAILURE_RATE: '0',
    MOCK_LATENCY_MS: '0',
    BCRYPT_ROUNDS: '4',
  };

  startProcess('api', path.join(root, 'apps', 'api', 'dist', 'main.js'), childEnv);
  startProcess('worker', path.join(root, 'apps', 'api', 'dist', 'worker.js'), childEnv);

  await poll('API readiness', () => request('/health/ready'), (response) => response.status === 200, 30_000);
  expectStatus('infrastructure', 'real PostgreSQL and Redis readiness', await request('/health/ready'), 200);

  // Authentication and tenant onboarding.
  const adminLogin = expectStatus('authentication', 'valid Super Admin login', await login(emails.admin, passwords.admin), [200, 201]);
  const adminToken = requireSuccessful(adminLogin, 'Super Admin login').accessToken;
  expectTruthy('authentication', 'Super Admin access token issued', adminToken);
  expectValue('authentication', 'Super Admin session is platform-scoped', adminLogin.data.user.tenantId, null);

  const onboardA = expectStatus(
    'super admin',
    'platform Super Admin onboards Tenant A',
    await request('/tenants', {
      method: 'POST',
      token: adminToken,
      body: {
        name: `Assurance Tenant A ${runTag}`,
        slug: slugs.tenantA,
        managerEmail: emails.managerA,
        managerFullName: 'Assurance Manager A',
        managerPassword: passwords.managerA,
        freeCreditsPaise: '500000',
      },
    }),
    [200, 201],
  );
  tenantAId = requireSuccessful(onboardA, 'Tenant A onboarding').tenant.id;

  const onboardB = expectStatus(
    'super admin',
    'platform Super Admin onboards Tenant B',
    await request('/tenants', {
      method: 'POST',
      token: adminToken,
      body: {
        name: `Assurance Tenant B ${runTag}`,
        slug: slugs.tenantB,
        managerEmail: emails.managerB,
        managerFullName: 'Assurance Manager B',
        managerPassword: passwords.managerB,
        freeCreditsPaise: '500000',
      },
    }),
    [200, 201],
  );
  tenantBId = requireSuccessful(onboardB, 'Tenant B onboarding').tenant.id;

  const managerALogin = expectStatus('authentication', 'valid Manager login', await login(emails.managerA, passwords.managerA, slugs.tenantA), [200, 201]);
  let managerAToken = requireSuccessful(managerALogin, 'Manager A login').accessToken;
  expectTruthy('authentication', 'refresh cookie is HttpOnly', managerALogin.setCookie?.includes('HttpOnly'));
  expectTruthy('authentication', 'refresh cookie uses SameSite=Lax', /SameSite=Lax/i.test(managerALogin.setCookie || ''));
  const managerBLogin = expectStatus('authentication', 'valid second-tenant Manager login', await login(emails.managerB, passwords.managerB, slugs.tenantB), [200, 201]);
  const managerBToken = requireSuccessful(managerBLogin, 'Manager B login').accessToken;

  const managerAUser = await prisma.user.findUniqueOrThrow({ where: { email: emails.managerA } });
  await prisma.tenantUser.create({
    data: {
      tenantId: tenantBId,
      userId: managerAUser.id,
      role: 'manager',
      inviteStatus: 'active',
      acceptedAt: new Date(),
      invitedBy: adminUserId,
    },
  });
  const staffAUser = await prisma.user.create({
    data: {
      email: emails.staffA,
      fullName: 'Assurance Staff A',
      passwordHash: await bcrypt.hash(passwords.staffA, 4),
      tenantUsers: {
        create: {
          tenantId: tenantAId,
          role: 'staff',
          inviteStatus: 'active',
          acceptedAt: new Date(),
          invitedBy: managerAUser.id,
        },
      },
    },
  });
  assert.ok(staffAUser.id);
  const staffALogin = expectStatus('authentication', 'valid Staff login', await login(emails.staffA, passwords.staffA, slugs.tenantA), [200, 201]);
  const staffAToken = requireSuccessful(staffALogin, 'Staff A login').accessToken;

  expectStatus('authentication', 'wrong password is rejected', await login(emails.managerA, `${passwords.managerA}-wrong`, slugs.tenantA), 401);
  expectStatus('authentication', 'unknown user is rejected', await login(`${runTag}.unknown@example.test`, passwords.managerA), 401);
  expectStatus('authentication', 'request without a token is rejected', await request('/auth/me'), 401);
  expectStatus('authentication', 'malformed token is rejected', await request('/auth/me', { token: 'not-a-jwt' }), 401);

  const managerClaims = decodeJwt(managerAToken);
  const expiredToken = signJwt({ ...managerClaims, iat: Math.floor(Date.now() / 1000) - 120, exp: Math.floor(Date.now() / 1000) - 60 });
  expectStatus('authentication', 'expired access token is rejected', await request('/auth/me', { token: expiredToken }), 401);

  const me = expectStatus('authentication', '/auth/me returns authenticated identity', await request('/auth/me', { token: managerAToken }), 200);
  expectValue('authentication', '/auth/me returns Manager role', me.data.role, 'manager');
  expectValue('authentication', '/auth/me returns Tenant A binding', me.data.tenantId, tenantAId);
  expectTruthy('authentication', '/auth/me includes templates:manage', me.data.permissions?.includes('templates:manage'));

  const refreshLoginResponse = await login(emails.managerA, passwords.managerA, slugs.tenantA);
  requireSuccessful(refreshLoginResponse, 'refresh test login');
  const originalRefreshCookie = refreshLoginResponse.cookie;
  const refreshed = expectStatus('authentication', 'refresh cookie rotates and issues a token', await request('/auth/refresh', { method: 'POST', cookie: originalRefreshCookie }), [200, 201]);
  expectTruthy('authentication', 'refresh rotation returns a replacement cookie', refreshed.cookie && refreshed.cookie !== originalRefreshCookie);
  expectStatus('authentication', 'rotated old refresh token is rejected', await request('/auth/refresh', { method: 'POST', cookie: originalRefreshCookie }), 401);

  const logoutLogin = requireSuccessful(await login(emails.managerA, passwords.managerA, slugs.tenantA), 'logout test login');
  expectStatus('authentication', 'logout succeeds', await request('/auth/logout', { method: 'POST', token: logoutLogin.accessToken, cookie: logoutLogin.cookie }), [200, 201]);
  expectStatus('authentication', 'logout revokes refresh session', await request('/auth/refresh', { method: 'POST', cookie: logoutLogin.cookie }), 401);
  expectStatus('authentication', 'logout revokes issued access token by session id', await request('/auth/me', { token: logoutLogin.accessToken }), 401);

  const memberships = expectStatus('authentication', 'membership listing succeeds', await request('/auth/memberships', { token: managerAToken }), 200);
  expectValue(
    'authentication',
    'multi-membership fixture has two active database memberships',
    await prisma.tenantUser.count({ where: { userId: managerAUser.id, inviteStatus: { in: ['active', 'invited'] } } }),
    2,
  );
  expectValue('authentication', 'multi-membership account sees both tenants', memberships.data.length, 2);
  const switchedLogin = expectStatus('authentication', 'login tenant selector opens Tenant B membership', await login(emails.managerA, passwords.managerA, slugs.tenantB), [200, 201]);
  expectValue('authentication', 'switched session JWT binds Tenant B', switchedLogin.data.user.tenantId, tenantBId);

  // Platform and support behavior.
  expectStatus('super admin', 'platform tenant listing succeeds', await request('/tenants', { token: adminToken }), 200);
  expectStatus('super admin', 'support permission is denied without an explicit tenant', await request('/contacts', { token: adminToken }), 403);
  expectStatus('super admin', 'query tenantId alone is not an explicit support selection', await request(`/contacts?tenantId=${tenantAId}`, { token: adminToken }), 403);
  expectStatus(
    'super admin',
    'explicit support header plus target query accesses Tenant A',
    await request(`/contacts?tenantId=${tenantAId}`, { token: adminToken, headers: { 'x-acting-tenant-id': tenantAId } }),
    200,
  );
  expectStatus(
    'super admin',
    'explicit but nonexistent support tenant fails closed',
    await request(`/contacts?tenantId=${randomUUID()}`, { token: adminToken, headers: { 'x-acting-tenant-id': randomUUID() } }),
    404,
  );
  expectStatus('authorization', 'Manager cannot list platform tenants', await request('/tenants', { token: managerAToken }), 403);
  expectStatus(
    'authorization',
    'Manager cannot onboard platform tenants',
    await request('/tenants', { method: 'POST', token: managerAToken, body: {} }),
    403,
  );

  const receiverA = `receiver-${runTag}-a`;
  const receiverB = `receiver-${runTag}-b`;
  expectStatus(
    'tenant setup',
    'Tenant A Manager configures its sending identity',
    await request('/tenants/current/sending-identity', { method: 'PATCH', token: managerAToken, body: { whatsappPhoneNumberId: receiverA } }),
    200,
  );
  expectStatus(
    'tenant setup',
    'Tenant B Manager configures its sending identity',
    await request('/tenants/current/sending-identity', { method: 'PATCH', token: managerBToken, body: { whatsappPhoneNumberId: receiverB } }),
    200,
  );

  const digits = Date.now().toString().slice(-8);
  const sharedPhone = `+919${digits}5`;
  const createContactA = expectStatus(
    'campaign E2E',
    'Tenant A Manager creates contact',
    await request('/contacts', {
      method: 'POST',
      token: managerAToken,
      body: { fullName: 'Assurance Contact A', phone: sharedPhone, email: `${runTag}.contact-a@example.test`, whatsappOptedIn: true, emailOptedIn: true },
    }),
    [200, 201],
  );
  const contactA = requireSuccessful(createContactA, 'Tenant A contact creation');
  const createContactB = expectStatus(
    'tenant isolation setup',
    'Tenant B may store the same customer phone independently',
    await request('/contacts', {
      method: 'POST',
      token: managerBToken,
      body: { fullName: 'Assurance Contact B', phone: sharedPhone, email: `${runTag}.contact-b@example.test`, whatsappOptedIn: true, emailOptedIn: true },
    }),
    [200, 201],
  );
  const contactB = requireSuccessful(createContactB, 'Tenant B contact creation');

  const generated = expectStatus(
    'authorization',
    'Manager can use Autopilot generate',
    await request('/templates/autopilot/generate', { method: 'POST', token: managerAToken, body: { channel: 'whatsapp', prompt: 'Create a concise delivery confirmation' } }),
    [200, 201],
  );
  const generatedTemplate = requireSuccessful(generated, 'Autopilot generation');
  generatedTemplate.name = `${runTag}-wa-a`;
  const templateAResponse = expectStatus(
    'authorization',
    'Manager can create a template',
    await request('/templates', { method: 'POST', token: managerAToken, body: generatedTemplate }),
    [200, 201],
  );
  let templateA = requireSuccessful(templateAResponse, 'Tenant A template creation');
  const updatedTemplateA = expectStatus(
    'authorization',
    'Manager can edit a template',
    await request(`/templates/${templateA.id}`, { method: 'PATCH', token: managerAToken, body: { body: `${templateA.body} Thank you.` } }),
    200,
  );
  templateA = requireSuccessful(updatedTemplateA, 'Tenant A template update');
  expectStatus(
    'authorization',
    'Manager can use Autopilot modify',
    await request(`/templates/${templateA.id}/autopilot/modify`, { method: 'POST', token: managerAToken, body: { instruction: 'Make it warmer without removing variables' } }),
    [200, 201],
  );

  expectStatus('authorization', 'Staff cannot create templates', await request('/templates', { method: 'POST', token: staffAToken, body: generatedTemplate }), 403);
  expectStatus('authorization', 'Staff cannot read templates while campaign policy is disabled', await request(`/templates/${templateA.id}`, { token: staffAToken }), 403);
  expectStatus('authorization', 'Staff cannot edit templates', await request(`/templates/${templateA.id}`, { method: 'PATCH', token: staffAToken, body: { body: 'unauthorized' } }), 403);
  expectStatus('authorization', 'Staff cannot use Autopilot generate', await request('/templates/autopilot/generate', { method: 'POST', token: staffAToken, body: { channel: 'email', prompt: 'Unauthorized' } }), 403);
  expectStatus('authorization', 'Staff cannot use Autopilot modify', await request(`/templates/${templateA.id}/autopilot/modify`, { method: 'POST', token: staffAToken, body: { instruction: 'Unauthorized' } }), 403);
  expectStatus('authorization', 'Staff call trigger is denied by default policy', await request('/calls', { method: 'POST', token: staffAToken, body: { contactId: contactA.id, objective: 'Unauthorized' } }), 403);
  expectStatus('authorization', 'Staff wallet top-up is denied', await request('/billing/topups', { method: 'POST', token: staffAToken, body: { amountPaise: '1000' } }), 403);
  expectStatus('authorization', 'Staff contact management remains allowed', await request(`/contacts/${contactA.id}`, { token: staffAToken }), 200);
  const staffWallet = expectStatus('authorization', 'Staff receives limited wallet view', await request('/wallet', { token: staffAToken }), 200);
  expectValue('authorization', 'Staff wallet response excludes itemized transactions', Array.isArray(staffWallet.data.transactions), false);

  templateA = requireSuccessful(
    expectStatus('campaign E2E', 'Manager submits template through normal lifecycle', await request(`/templates/${templateA.id}/submit`, { method: 'POST', token: managerAToken }), [200, 201]),
    'Tenant A template submission',
  );
  expectValue('campaign E2E', 'mock provider approves submitted template', templateA.status, 'approved');

  const templateB = requireSuccessful(
    expectStatus(
      'tenant isolation setup',
      'Tenant B creates template',
      await request('/templates', { method: 'POST', token: managerBToken, body: { name: `${runTag}-wa-b`, channel: 'whatsapp', language: 'en', body: 'Hi {{fullName}}, Tenant B delivery update.' } }),
      [200, 201],
    ),
    'Tenant B template creation',
  );
  await request(`/templates/${templateB.id}/submit`, { method: 'POST', token: managerBToken });

  const campaignB = requireSuccessful(
    expectStatus(
      'tenant isolation setup',
      'Tenant B creates a campaign fixture',
      await request('/campaigns', { method: 'POST', token: managerBToken, body: { name: `${runTag} Campaign B`, channel: 'whatsapp', templateId: templateB.id, contactIds: [contactB.id] } }),
      [200, 201],
    ),
    'Tenant B campaign creation',
  );
  const importB = requireSuccessful(
    expectStatus(
      'tenant isolation setup',
      'Tenant B queues contact import fixture',
      await request('/contacts/import', { method: 'POST', token: managerBToken, body: { csv: `fullName,email\nImported B,${runTag}.import-b@example.test` } }),
      [200, 201],
    ),
    'Tenant B import creation',
  );
  await poll('Tenant B import', () => request(`/contacts/imports/${importB.id}`, { token: managerBToken }), (response) => ['completed', 'failed'].includes(response.data?.status));
  const callB = requireSuccessful(
    expectStatus(
      'tenant isolation setup',
      'Tenant B queues direct call fixture',
      await request('/calls', { method: 'POST', token: managerBToken, body: { contactId: contactB.id, objective: 'Tenant B isolation fixture' } }),
      [200, 201],
    ),
    'Tenant B call creation',
  );
  await poll('Tenant B call placement', () => request(`/calls/${callB.id}`, { token: managerBToken }), (response) => response.data?.status !== 'queued');

  const crossTenantChecks = [
    ['GET Tenant B contact', `/contacts/${contactB.id}`, { token: managerAToken }, 404],
    ['PATCH Tenant B contact', `/contacts/${contactB.id}`, { method: 'PATCH', token: managerAToken, body: { fullName: 'Cross-tenant mutation' } }, 404],
    ['DELETE Tenant B contact is deliberately idempotent', `/contacts/${contactB.id}`, { method: 'DELETE', token: managerAToken }, 204],
    ['GET Tenant B template', `/templates/${templateB.id}`, { token: managerAToken }, 404],
    ['PATCH Tenant B template', `/templates/${templateB.id}`, { method: 'PATCH', token: managerAToken, body: { body: 'Cross-tenant mutation' } }, 404],
    ['Autopilot modify Tenant B template', `/templates/${templateB.id}/autopilot/modify`, { method: 'POST', token: managerAToken, body: { instruction: 'Cross-tenant mutation' } }, 404],
    ['GET Tenant B campaign', `/campaigns/${campaignB.id}`, { token: managerAToken }, 404],
    ['launch Tenant B campaign', `/campaigns/${campaignB.id}/launch`, { method: 'POST', token: managerAToken }, 404],
    ['resume Tenant B campaign', `/campaigns/${campaignB.id}/resume`, { method: 'POST', token: managerAToken }, 404],
    ['cancel Tenant B campaign', `/campaigns/${campaignB.id}/cancel`, { method: 'POST', token: managerAToken, body: { reason: 'Cross-tenant mutation' } }, 404],
    ['GET Tenant B call', `/calls/${callB.id}`, { token: managerAToken }, 404],
    ['GET Tenant B import status', `/contacts/imports/${importB.id}`, { token: managerAToken }, 404],
    ['GET Tenant B contact timeline', `/timeline/contact/${contactB.id}`, { token: managerAToken }, 404],
    ['GET Tenant B wallet route', `/wallet/tenants/${tenantBId}`, { token: managerAToken }, 403],
  ];
  for (const [check, endpoint, options, expected] of crossTenantChecks) {
    expectStatus('cross-tenant HTTP/IDOR', check, await request(endpoint, options), expected);
  }
  const contactBAfter = await request(`/contacts/${contactB.id}`, { token: managerBToken });
  expectValue('cross-tenant mutation', 'Tenant B contact name is unchanged', contactBAfter.data.fullName, 'Assurance Contact B');
  expectValue('cross-tenant mutation', 'Tenant B contact remains unarchived', contactBAfter.data.deletedAt ?? null, null);
  const campaignBAfter = await request(`/campaigns/${campaignB.id}`, { token: managerBToken });
  expectValue('cross-tenant mutation', 'Tenant B campaign remains a draft', campaignBAfter.data.status, 'draft');
  expectValue(
    'cross-tenant mutation',
    'Tenant B template body is unchanged',
    (await prisma.template.findUniqueOrThrow({ where: { id: templateB.id } })).body,
    'Hi {{fullName}}, Tenant B delivery update.',
  );
  expectValue('cross-tenant mutation', 'Tenant B call ownership is unchanged', (await prisma.call.findUniqueOrThrow({ where: { id: callB.id } })).tenantId, tenantBId);
  expectValue('cross-tenant mutation', 'Tenant B import ownership is unchanged', (await prisma.contactImport.findUniqueOrThrow({ where: { id: importB.id } })).tenantId, tenantBId);

  const injectionName = `Injection ${runTag}`;
  expectStatus(
    'tenant-id injection',
    'body tenantId cannot override Tenant A context',
    await request('/contacts', { method: 'POST', token: managerAToken, body: { tenantId: tenantBId, fullName: injectionName, email: `${runTag}.inject@example.test` } }),
    403,
  );
  expectStatus('tenant-id injection', 'query tenantId cannot override Tenant A context', await request(`/contacts?tenantId=${tenantBId}`, { token: managerAToken }), 403);
  expectStatus('tenant-id injection', 'route tenantId cannot override Tenant A context', await request(`/tenants/${tenantBId}`, { token: managerAToken }), 403);
  expectStatus('tenant-id injection', 'header tenant id cannot override Tenant A context', await request('/contacts', { token: managerAToken, headers: { 'x-tenant-id': tenantBId } }), 403);
  const injectedRows = await prisma.contact.count({ where: { fullName: injectionName } });
  expectValue('tenant-id injection', 'no injected contact row was created', injectedRows, 0);

  // Staff receives campaign authority through tenant policy, but still cannot manage templates.
  expectStatus(
    'authorization separation',
    'Manager enables only Staff campaign authority',
    await request('/tenants/current/settings', { method: 'PATCH', token: managerAToken, body: { staffCanLaunchCampaigns: true, staffCanTriggerCalls: false } }),
    200,
  );
  const staffCampaign = requireSuccessful(
    expectStatus(
      'authorization separation',
      'campaigns:launch policy lets Staff create a campaign',
      await request('/campaigns', { method: 'POST', token: staffAToken, body: { name: `${runTag} Staff Campaign`, channel: 'whatsapp', templateId: templateA.id, contactIds: [contactA.id] } }),
      [200, 201],
    ),
    'Staff campaign creation',
  );
  expectStatus('authorization separation', 'campaigns:launch policy lets Staff launch', await request(`/campaigns/${staffCampaign.id}/launch`, { method: 'POST', token: staffAToken }), [200, 201]);
  expectStatus('authorization separation', 'campaign policy enables the existing template-read permission', await request(`/templates/${templateA.id}`, { token: staffAToken }), 200);
  expectStatus('authorization separation', 'campaign authority still does not grant template edit', await request(`/templates/${templateA.id}`, { method: 'PATCH', token: staffAToken, body: { body: 'Still unauthorized' } }), 403);
  expectStatus('authorization separation', 'campaign authority still does not grant Autopilot modify', await request(`/templates/${templateA.id}/autopilot/modify`, { method: 'POST', token: staffAToken, body: { instruction: 'Still unauthorized' } }), 403);
  expectStatus('authorization separation', 'calls remain denied when only campaign policy is enabled', await request('/calls', { method: 'POST', token: staffAToken, body: { contactId: contactA.id, objective: 'Still unauthorized' } }), 403);

  // Manager campaign through BullMQ, mock provider, callback, timeline, and wallet.
  const walletBeforeCampaign = await prisma.wallet.findUniqueOrThrow({ where: { tenantId: tenantAId } });
  const campaignA = requireSuccessful(
    expectStatus(
      'campaign E2E',
      'Manager creates Tenant A campaign',
      await request('/campaigns', { method: 'POST', token: managerAToken, body: { name: `${runTag} Manager Campaign`, channel: 'whatsapp', templateId: templateA.id, contactIds: [contactA.id] } }),
      [200, 201],
    ),
    'Tenant A campaign creation',
  );
  expectStatus('campaign E2E', 'Manager launches Tenant A campaign', await request(`/campaigns/${campaignA.id}/launch`, { method: 'POST', token: managerAToken }), [200, 201]);
  const recipientPage = await poll(
    'Tenant A campaign delivery callback',
    () => request(`/campaigns/${campaignA.id}/recipients`, { token: managerAToken }),
    (response) => response.data?.items?.some((recipient) => ['delivered', 'read'].includes(recipient.status)),
    30_000,
  );
  const recipientA = recipientPage.data.items[0];
  expectTruthy('campaign E2E', 'worker assigned provider message id', recipientA.providerMessageId);
  const persistedCampaignRows = await prisma.campaign.findUnique({ where: { id: campaignA.id }, include: { recipients: true } });
  expectValue('campaign E2E', 'campaign row belongs to Tenant A', persistedCampaignRows.tenantId, tenantAId);
  expectValue('campaign E2E', 'recipient row belongs to Tenant A', persistedCampaignRows.recipients[0].tenantId, tenantAId);
  const campaignTimeline = await request(`/timeline/contact/${contactA.id}`, { token: managerAToken });
  expectStatus('campaign E2E', 'campaign timeline is readable', campaignTimeline, 200);
  expectTruthy('campaign E2E', 'timeline contains campaign activity', campaignTimeline.data.events?.some((event) => event.campaignId === campaignA.id));
  const walletAfterCampaign = await prisma.wallet.findUniqueOrThrow({ where: { tenantId: tenantAId } });
  expectTruthy('campaign E2E', 'campaign produces a wallet debit', walletAfterCampaign.lifetimeDebitedPaise > walletBeforeCampaign.lifetimeDebitedPaise);
  expectStatus('campaign E2E', 'Tenant B cannot read Tenant A campaign', await request(`/campaigns/${campaignA.id}`, { token: managerBToken }), 404);

  const emailTemplateA = requireSuccessful(
    expectStatus(
      'webhook isolation',
      'Tenant A creates an email template',
      await request('/templates', {
        method: 'POST',
        token: managerAToken,
        body: { name: `${runTag}-email-a`, channel: 'email', language: 'en', subject: 'Delivery update', body: 'Hi {{fullName}}, your delivery is scheduled.' },
      }),
      [200, 201],
    ),
    'Tenant A email template creation',
  );
  await request(`/templates/${emailTemplateA.id}/submit`, { method: 'POST', token: managerAToken });
  const emailCampaignA = requireSuccessful(
    expectStatus(
      'webhook isolation',
      'Tenant A creates an email campaign',
      await request('/campaigns', { method: 'POST', token: managerAToken, body: { name: `${runTag} Email Campaign`, channel: 'email', templateId: emailTemplateA.id, contactIds: [contactA.id] } }),
      [200, 201],
    ),
    'Tenant A email campaign creation',
  );
  expectStatus('webhook isolation', 'Tenant A launches email campaign', await request(`/campaigns/${emailCampaignA.id}/launch`, { method: 'POST', token: managerAToken }), [200, 201]);
  const emailRecipients = await poll(
    'Tenant A email delivery callback',
    () => request(`/campaigns/${emailCampaignA.id}/recipients`, { token: managerAToken }),
    (response) => response.data?.items?.some((recipient) => recipient.status === 'delivered'),
    30_000,
  );
  const emailRecipientA = emailRecipients.data.items[0];
  expectValue('webhook isolation', 'email callback recipient remains Tenant A owned', (await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: emailRecipientA.id } })).tenantId, tenantAId);
  expectTruthy('webhook isolation', 'signed mock email callback was processed through delivery ledger', await prisma.webhookDelivery.findFirst({ where: { provider: 'email', processed: true, payload: { path: ['mail', 'messageId'], equals: emailRecipientA.providerMessageId } } }));
  expectStatus('webhook isolation', 'Tenant B cannot read Tenant A email campaign', await request(`/campaigns/${emailCampaignA.id}`, { token: managerBToken }), 404);

  // Contact import through a separate worker process.
  const importA = requireSuccessful(
    expectStatus(
      'worker isolation',
      'Tenant A submits contact import',
      await request('/contacts/import', { method: 'POST', token: managerAToken, body: { csv: `fullName,email\nImported A,${runTag}.import-a@example.test` } }),
      [200, 201],
    ),
    'Tenant A import creation',
  );
  const completedImportA = await poll('Tenant A contact import worker', () => request(`/contacts/imports/${importA.id}`, { token: managerAToken }), (response) => response.data?.status === 'completed');
  expectValue('worker isolation', 'contact-import completes in BullMQ worker', completedImportA.data.status, 'completed');
  expectStatus('worker isolation', 'Tenant B cannot read Tenant A import', await request(`/contacts/imports/${importA.id}`, { token: managerBToken }), 404);

  // Direct-call pipeline through BullMQ and mock telephony callbacks.
  const walletBeforeCall = await prisma.wallet.findUniqueOrThrow({ where: { tenantId: tenantAId } });
  const callA = requireSuccessful(
    expectStatus(
      'direct call E2E',
      'Manager queues a direct call',
      await request('/calls', { method: 'POST', token: managerAToken, body: { contactId: contactA.id, objective: 'Confirm the delivery address' } }),
      [200, 201],
    ),
    'Tenant A direct call creation',
  );
  const completedCallA = await poll(
    'Tenant A direct call pipeline',
    () => request(`/calls/${callA.id}`, { token: managerAToken }),
    (response) => Boolean(response.data?.summary && response.data?.recordingKey),
    30_000,
  );
  expectTruthy('direct call E2E', 'mock call stores summary', completedCallA.data.summary);
  expectTruthy('direct call E2E', 'mock call stores next action', completedCallA.data.nextAction);
  expectTruthy('direct call E2E', 'mock call stores transcript turns', completedCallA.data.transcript?.length);
  const recordingAccess = expectStatus('direct call E2E', 'recording path issues a signed URL', await request(`/calls/${callA.id}/recording`, { token: managerAToken }), 200);
  expectStatus('direct call E2E', 'signed recording URL serves the mock recording', await request(recordingAccess.data.url), 200);
  const tamperedRecordingUrl = new URL(recordingAccess.data.url);
  tamperedRecordingUrl.searchParams.set('sig', '0'.repeat(64));
  expectStatus('direct call E2E', 'tampered recording signature is rejected', await request(tamperedRecordingUrl.toString()), 401);
  const walletAfterCall = await prisma.wallet.findUniqueOrThrow({ where: { tenantId: tenantAId } });
  expectTruthy('direct call E2E', 'completed call produces a wallet debit', walletAfterCall.lifetimeDebitedPaise > walletBeforeCall.lifetimeDebitedPaise);
  expectStatus('direct call E2E', 'Tenant B cannot access Tenant A call', await request(`/calls/${callA.id}`, { token: managerBToken }), 404);

  // Deliberately mismatched BullMQ payloads. Each lookup is scoped to Tenant A.
  await malformedJob('campaign-dispatch', { tenantId: tenantAId, campaignId: campaignB.id }, async () => {
    const current = await prisma.campaign.findUnique({ where: { id: campaignB.id } });
    return current?.status === 'draft';
  });
  await malformedJob('contact-import', { tenantId: tenantAId, importId: importB.id }, async () => {
    const current = await prisma.contactImport.findUnique({ where: { id: importB.id } });
    return current?.tenantId === tenantBId;
  });
  await malformedJob('call-place', { tenantId: tenantAId, callId: callB.id }, async () => {
    const current = await prisma.call.findUnique({ where: { id: callB.id } });
    return current?.tenantId === tenantBId;
  });

  // Meta inbound tenant is resolved by receiver identity, even with the same sender in both CRMs.
  const inboundId = `wamid.${runTag}.inbound`;
  const inboundPayload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'entry_assurance', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '+919999000000', phone_number_id: receiverB },
      messages: [{ from: sharedPhone.slice(1), id: inboundId, timestamp: Math.floor(Date.now() / 1000).toString(), text: { body: 'Tenant-safe inbound' }, type: 'text' }],
    } }] }],
  });
  expectStatus('webhook isolation', 'invalid Meta signature is rejected', await request('/webhooks/meta', { method: 'POST', rawBody: inboundPayload, headers: { 'x-hub-signature-256': 'sha256=invalid' } }), 401);
  expectStatus('webhook isolation', 'valid Meta inbound callback is accepted', await request('/webhooks/meta', { method: 'POST', rawBody: inboundPayload, headers: { 'x-hub-signature-256': signMeta(inboundPayload) } }), 200);
  expectStatus('webhook isolation', 'replayed Meta inbound callback is idempotently acknowledged', await request('/webhooks/meta', { method: 'POST', rawBody: inboundPayload, headers: { 'x-hub-signature-256': signMeta(inboundPayload) } }), 200);
  const inboundEvents = await prisma.communicationEvent.findMany({ where: { providerReference: inboundId } });
  expectValue('webhook isolation', 'receiver identity routes inbound message only to Tenant B', inboundEvents.filter((row) => row.tenantId === tenantBId).length, 1);
  expectValue('webhook isolation', 'same sender does not route inbound message to Tenant A', inboundEvents.filter((row) => row.tenantId === tenantAId).length, 0);

  // Razorpay ownership and replay idempotency through the HTTP webhook endpoint.
  const topup = requireSuccessful(
    expectStatus('webhook isolation', 'Manager creates internal Razorpay order', await request('/billing/topups', { method: 'POST', token: managerAToken, body: { amountPaise: '1000' } }), [200, 201]),
    'Razorpay order creation',
  );
  const walletBeforeTopup = await prisma.wallet.findUniqueOrThrow({ where: { tenantId: tenantAId } });
  const capture = requireSuccessful(
    expectStatus('webhook isolation', 'mock checkout emits signed Razorpay callback', await request(`/billing/topups/${topup.orderId}/mock-capture`, { method: 'POST', token: managerAToken }), [200, 201]),
    'Razorpay mock capture',
  );
  await poll('Razorpay capture', () => prisma.razorpayPayment.findUnique({ where: { razorpayPaymentId: capture.razorpayPaymentId } }), (payment) => Boolean(payment?.creditedAt));
  const walletAfterTopup = await prisma.wallet.findUniqueOrThrow({ where: { tenantId: tenantAId } });
  expectValue('webhook isolation', 'internal order credits exactly its amount', walletAfterTopup.balancePaise - walletBeforeTopup.balancePaise, 1000n);
  const razorpayPayload = JSON.stringify({
    entity: 'event', account_id: 'acc_mock', event: 'payment.captured', contains: ['payment'],
    payload: { payment: { entity: { id: capture.razorpayPaymentId, entity: 'payment', amount: 1000, currency: 'INR', status: 'captured', order_id: topup.razorpayOrderId, method: 'upi' } } },
    created_at: Math.floor(Date.now() / 1000),
  });
  expectStatus('webhook isolation', 'Razorpay replay is acknowledged', await request('/webhooks/razorpay', { method: 'POST', rawBody: razorpayPayload, headers: { 'x-razorpay-signature': signRazorpay(razorpayPayload) } }), 200);
  expectStatus('webhook isolation', 'second Razorpay replay is acknowledged', await request('/webhooks/razorpay', { method: 'POST', rawBody: razorpayPayload, headers: { 'x-razorpay-signature': signRazorpay(razorpayPayload) } }), 200);
  const walletAfterReplays = await prisma.wallet.findUniqueOrThrow({ where: { tenantId: tenantAId } });
  expectValue('webhook isolation', 'Razorpay replay cannot double-credit wallet', walletAfterReplays.balancePaise, walletAfterTopup.balancePaise);
  expectValue('webhook isolation', 'Razorpay payment ownership remains Tenant A', (await prisma.razorpayPayment.findUniqueOrThrow({ where: { razorpayPaymentId: capture.razorpayPaymentId } })).tenantId, tenantAId);
  expectValue('webhook isolation', 'Razorpay idempotency ledger has one credit', await prisma.walletTransaction.count({ where: { tenantId: tenantAId, idempotencyKey: `razorpay:${capture.razorpayPaymentId}` } }), 1);

  // Every object produced by the principal journey is tenant-bound.
  const objectOwnership = await Promise.all([
    prisma.contact.findUnique({ where: { id: contactA.id }, select: { tenantId: true } }),
    prisma.template.findUnique({ where: { id: templateA.id }, select: { tenantId: true } }),
    prisma.campaign.findUnique({ where: { id: campaignA.id }, select: { tenantId: true } }),
    prisma.call.findUnique({ where: { id: callA.id }, select: { tenantId: true } }),
    prisma.contactImport.findUnique({ where: { id: importA.id }, select: { tenantId: true } }),
  ]);
  expectValue('tenant ownership', 'all principal E2E objects belong to Tenant A', objectOwnership.every((row) => row?.tenantId === tenantAId), true);

  for (const row of evidence) {
    console.log(`${row.passed ? 'PASS' : 'FAIL'} | ${row.area} | ${row.check} | actual=${row.actual} expected=${row.expected}`);
  }
  console.log(`ASSURANCE SUMMARY | passed=${evidence.length - failures.length} failed=${failures.length}`);
  if (failures.length) process.exitCode = 1;
}

try {
  await run();
} catch (error) {
  console.error(`ASSURANCE FATAL | ${error instanceof Error ? error.message : String(error)}`);
  for (const [name, log] of childLogs) {
    console.error(`--- ${name} tail ---\n${log}`);
  }
  process.exitCode = 1;
} finally {
  await cleanup();
}
