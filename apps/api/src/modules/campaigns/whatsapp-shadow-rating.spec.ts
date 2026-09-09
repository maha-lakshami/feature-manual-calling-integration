import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

import { Channel, CostSource, RecipientStatus } from '@aiking/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { ExtendedPrismaClient, createTenantIsolationExtension } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { RatingEngineService } from '../billing/rating-engine.service';
import { RateCatalogService } from '../rate-catalog/rate-catalog.service';
import { WhatsAppShadowRatingService } from './whatsapp-shadow-rating.service';

describe('WhatsAppShadowRatingService (Phase 5)', () => {
  let service: WhatsAppShadowRatingService;
  let rateCatalog: RateCatalogService;
  let prisma: ExtendedPrismaClient;
  let tenantContext: TenantContext;

  const tenantA = '33333333-3333-3333-3333-333333333333';
  const tenantB = '44444444-4444-4444-4444-444444444444';
  const testUserId = '00000000-0000-0000-0000-000000000001';
  let contactAId: string;
  let campaignAId: string;

  function runWithTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.runWithTenant(
      {
        tenantId,
        userId: testUserId,
        role: 'manager' as any,
        isSuperAdmin: false,
        viaSupport: false,
        viaWorker: false,
      },
      fn,
    );
  }

  let contactCounter = 1000;
  async function createRecipient(data: any) {
    contactCounter++;
    const contact = await runWithTenant(data.tenantId, async () =>
      prisma.contact.create({
        data: {
          tenantId: data.tenantId,
          fullName: `Contact ${contactCounter}`,
          phone: `+91987000${contactCounter}`,
        },
      }),
    );
    return runWithTenant(data.tenantId, async () =>
      prisma.campaignRecipient.create({
        data: {
          ...data,
          contactId: contact.id,
        },
      }),
    );
  }

  beforeAll(async () => {
    tenantContext = new TenantContext();

    const adapter = new PrismaPg({
      connectionString:
        process.env.DATABASE_URL ||
        'postgresql://aiking:aiking@127.0.0.1:5433/aiking',
    });
    const baseClient = new PrismaClient({ adapter });
    prisma = baseClient.$extends(createTenantIsolationExtension(tenantContext)) as unknown as ExtendedPrismaClient;

    rateCatalog = new RateCatalogService(prisma);
    const ratingEngine = new RatingEngineService();
    service = new WhatsAppShadowRatingService(prisma, rateCatalog, ratingEngine, tenantContext);

    // Setup tenants
    await tenantContext.runAsSystem('setup tenant A', async () =>
      await prisma.tenant.upsert({
        where: { id: tenantA },
        create: { id: tenantA, name: 'Tenant A WhatsApp', slug: 'tenant-a-wa-shadow' },
        update: {},
      }),
    );
    await tenantContext.runAsSystem('setup tenant B', async () =>
      await prisma.tenant.upsert({
        where: { id: tenantB },
        create: { id: tenantB, name: 'Tenant B WhatsApp', slug: 'tenant-b-wa-shadow' },
        update: {},
      }),
    );

    // Create test contact under tenant A
    const contactA = await runWithTenant(tenantA, async () =>
      await prisma.contact.create({
        data: {
          tenantId: tenantA,
          fullName: 'Contact WhatsApp A',
          phone: '+919870000001',
        },
      }),
    );
    contactAId = contactA.id;

    // Create test campaign
    const campaignA = await runWithTenant(tenantA, async () =>
      await prisma.campaign.create({
        data: {
          tenantId: tenantA,
          name: 'WhatsApp Campaign A',
          channel: Channel.WHATSAPP,
          status: 'queued',
          createdBy: testUserId,
        },
      }),
    );
    campaignAId = campaignA.id;

    // Configure test wholesale rates in RateCatalog
    // 1. Meta India Utility rate: 12.5 paise = 12,500,000 micro-paise
    await rateCatalog.upsertRate({
      provider: 'meta',
      channel: Channel.WHATSAPP,
      destinationPattern: '91',
      category: 'utility',
      unit: 'message',
      rateMicroPaise: 12_500_000n,
      currency: 'INR',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });

    // 2. Meta India Marketing rate: 80.0 paise = 80,000,000 micro-paise
    await rateCatalog.upsertRate({
      provider: 'meta',
      channel: Channel.WHATSAPP,
      destinationPattern: '91',
      category: 'marketing',
      unit: 'message',
      rateMicroPaise: 80_000_000n,
      currency: 'INR',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });

    // 3. Meta India Service rate: 35.0 paise = 35,000,000 micro-paise
    await rateCatalog.upsertRate({
      provider: 'meta',
      channel: Channel.WHATSAPP,
      destinationPattern: '91',
      category: 'service',
      unit: 'message',
      rateMicroPaise: 35_000_000n,
      currency: 'INR',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });

    // 4. Mock-WhatsApp India Generic rate (category = null): 50.0 paise = 50,000,000 micro-paise
    await rateCatalog.upsertRate({
      provider: 'mock-whatsapp',
      channel: Channel.WHATSAPP,
      destinationPattern: '91',
      category: null,
      unit: 'message',
      rateMicroPaise: 50_000_000n,
      currency: 'INR',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });

    // 5. Meta UK Large-BigInt rate: 12_345_678_901_234_567 micro-paise (> Number.MAX_SAFE_INTEGER)
    await rateCatalog.upsertRate({
      provider: 'meta',
      channel: Channel.WHATSAPP,
      destinationPattern: '44',
      category: 'large-bigint',
      unit: 'message',
      rateMicroPaise: 12_345_678_901_234_567n,
      currency: 'INR',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });

    // 6. Meta UK Fractional rate: 123_456 micro-paise (0.123456 paise)
    await rateCatalog.upsertRate({
      provider: 'meta',
      channel: Channel.WHATSAPP,
      destinationPattern: '44',
      category: 'fractional',
      unit: 'message',
      rateMicroPaise: 123_456n,
      currency: 'INR',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
  });

  afterAll(async () => {
    await tenantContext.runAsSystem('cleanup test data', async () => {
      await prisma.whatsAppShadowRatingConflict.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
      await prisma.whatsAppCampaignShadowReconciliation.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
      await prisma.whatsAppShadowRating.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
      await prisma.campaignRecipient.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
      await prisma.campaign.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
      await prisma.contact.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
      await prisma.providerRate.deleteMany({
        where: { provider: { in: ['meta', 'mock-whatsapp'] } },
      });
    });
    await prisma.$disconnect();
  });

  describe('1. Authoritative Rating & Category Semantics', () => {
    it('rates a WhatsApp recipient with exact category and micro-paise precision', async () => {
      const recipient = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        contactId: contactAId,
        destination: '+919876543210',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.HBgL1234567890',
        providerCategory: 'utility',
        providerPricingModel: 'CBP',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n, // Legacy 85 paise charge
      });

      const result = await runWithTenant(tenantA, () =>
        service.rateRecipientSafely(recipient.id),
      );

      expect(result.recorded).toBe(true);
      expect(result.shadowRating?.status).toBe('RATED');
      expect(result.shadowRating?.provider).toBe('meta');
      expect(result.shadowRating?.category).toBe('utility');
      expect(result.shadowRating?.rateMicroPaise).toBe('12500000');
      expect(result.shadowRating?.providerCostMicroPaise).toBe('12500000');
      expect(result.shadowRating?.legacyCustomerChargePaise).toBe('85');
      expect(result.shadowRating?.costSource).toBe(CostSource.RATE_CATALOG);
    });

    it('resolves generic rate when category is missing and generic rate is configured', async () => {
      const recipient = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        contactId: contactAId,
        destination: '+919876543211',
        status: RecipientStatus.DELIVERED,
        provider: 'mock-whatsapp',
        providerMessageId: 'wamid.mock.generic.1',
        providerCategory: null, // missing category
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      const result = await runWithTenant(tenantA, () =>
        service.rateRecipientSafely(recipient.id),
      );

      expect(result.recorded).toBe(true);
      expect(result.shadowRating?.status).toBe('RATED');
      expect(result.shadowRating?.provider).toBe('mock-whatsapp');
      expect(result.shadowRating?.category).toBeNull();
      expect(result.shadowRating?.rateMicroPaise).toBe('50000000');
    });

    it('fails closed with CATEGORY_UNAVAILABLE when category is missing and no generic rate exists (never defaults to marketing)', async () => {
      const recipient = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        contactId: contactAId,
        destination: '+919876543212',
        status: RecipientStatus.DELIVERED,
        provider: 'meta', // meta has no generic rate, only utility/marketing/service
        providerMessageId: 'wamid.meta.nocat.1',
        providerCategory: null,
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      const result = await runWithTenant(tenantA, () =>
        service.rateRecipientSafely(recipient.id),
      );

      expect(result.recorded).toBe(true);
      expect(result.shadowRating?.status).toBe('CATEGORY_UNAVAILABLE');
      expect(result.shadowRating?.unavailableReason).toBe('CATEGORY_MISSING_AND_NO_GENERIC_RATE');
      expect(result.shadowRating?.rateMicroPaise).toBeNull();
      expect(result.shadowRating?.providerCostMicroPaise).toBeNull();
      expect(result.shadowRating?.legacyCustomerChargePaise).toBe('85');
    });

    it('records NON_BILLABLE with 0 provider cost when Meta reports billable=false', async () => {
      const recipient = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        contactId: contactAId,
        destination: '+919876543213',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.meta.nonbillable.1',
        providerCategory: 'service',
        providerPricingModel: 'CBP',
        providerBillable: false,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      const result = await runWithTenant(tenantA, () =>
        service.rateRecipientSafely(recipient.id),
      );

      expect(result.recorded).toBe(true);
      expect(result.shadowRating?.status).toBe('NON_BILLABLE');
      expect(result.shadowRating?.billable).toBe(false);
      expect(result.shadowRating?.providerCostMicroPaise).toBe('0');
      expect(result.shadowRating?.rateMicroPaise).toBe('0');
      expect(result.shadowRating?.legacyCustomerChargePaise).toBe('85');
    });

    it('fails closed with PROVIDER_UNKNOWN and provider=null when recipient.provider is missing', async () => {
      const recipient = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        contactId: contactAId,
        destination: '+919876543214',
        status: RecipientStatus.DELIVERED,
        provider: null, // unknown provider
        providerMessageId: 'wamid.legacy.noprov.1',
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      const result = await runWithTenant(tenantA, () =>
        service.rateRecipientSafely(recipient.id),
      );

      expect(result.recorded).toBe(true);
      expect(result.shadowRating?.status).toBe('PROVIDER_UNKNOWN');
      expect(result.shadowRating?.provider).toBeNull();
      expect(result.shadowRating?.unavailableReason).toBe('RECIPIENT_PROVIDER_MISSING');
    });

    it('fails closed with COST_UNAVAILABLE when rate is not configured for destination', async () => {
      const recipient = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        contactId: contactAId,
        destination: '+12025550199', // US destination, no rate in catalog
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.meta.us.1',
        providerCategory: 'utility',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      const result = await runWithTenant(tenantA, () =>
        service.rateRecipientSafely(recipient.id),
      );

      expect(result.recorded).toBe(true);
      expect(result.shadowRating?.status).toBe('COST_UNAVAILABLE');
      expect(result.shadowRating?.unavailableReason).toBe('RATE_NOT_CONFIGURED');
    });

    it('fails closed and records durable INVALID_STATE (SENT_AT_MISSING) when recipient.sentAt is missing, without timestamp fabrication', async () => {
      const recipient = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        contactId: contactAId,
        destination: '+919876543213',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.meta.missing.sentAt.1',
        providerCategory: 'utility',
        providerBillable: true,
        sentAt: null, // missing authoritative sentAt
        costPaise: 85n,
      });

      const result = await runWithTenant(tenantA, () =>
        service.rateRecipientSafely(recipient.id),
      );

      expect(result.recorded).toBe(true);
      expect(result.shadowRating?.status).toBe('INVALID_STATE');
      expect(result.shadowRating?.unavailableReason).toBe('SENT_AT_MISSING');
      expect(result.shadowRating?.occurredAt).toBeNull();

      // Verify row is durably persisted
      const persisted = await runWithTenant(tenantA, () =>
        service.getShadowRatingForRecipient(recipient.id),
      );
      expect(persisted).not.toBeNull();
      expect(persisted?.status).toBe('INVALID_STATE');
      expect(persisted?.occurredAt).toBeNull();

      // Verify idempotent replay
      const replay = await runWithTenant(tenantA, () =>
        service.rateRecipientSafely(recipient.id),
      );
      expect(replay.recorded).toBe(true);
      expect(replay.isDuplicate).toBe(true);
      expect(replay.conflict).toBe(false);
    });
  });

  describe('2. Idempotency & Conflict Safety', () => {
    it('returns existing shadow rating on exact replay without duplicate row', async () => {
      const recipient = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        contactId: contactAId,
        destination: '+919876543220',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.replay.test.1',
        providerCategory: 'marketing',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      const first = await runWithTenant(tenantA, () =>
        service.rateRecipientSafely(recipient.id),
      );
      expect(first.recorded).toBe(true);
      expect(first.isDuplicate).toBe(false);

      const second = await runWithTenant(tenantA, () =>
        service.rateRecipientSafely(recipient.id),
      );
      expect(second.recorded).toBe(true);
      expect(second.isDuplicate).toBe(true);
      expect(second.shadowRating?.id).toBe(first.shadowRating?.id);

      const count = await runWithTenant(tenantA, async () =>
        prisma.whatsAppShadowRating.count({ where: { campaignRecipientId: recipient.id } }),
      );
      expect(count).toBe(1);
    });

    it('detects conflicting replay, writes to WhatsAppShadowRatingConflict, and leaves original row unmutated', async () => {
      const recipient = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        contactId: contactAId,
        destination: '+919876543221',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.conflict.test.1',
        providerCategory: 'utility',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      const original = await runWithTenant(tenantA, () =>
        service.rateRecipientSafely(recipient.id),
      );
      expect(original.recorded).toBe(true);

      // Mutate recipient row to simulate conflicting replay inputs
      await runWithTenant(tenantA, async () =>
        prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: {
            costPaise: 120n, // conflicting legacy cost
            destination: '+919999999999', // conflicting destination
          },
        }),
      );

      const conflictResult = await runWithTenant(tenantA, () =>
        service.rateRecipientSafely(recipient.id),
      );

      expect(conflictResult.recorded).toBe(false);
      if (!conflictResult.recorded) {
        expect(conflictResult.conflict).toBe(true);
        expect(conflictResult.reason).toBe('RECONCILIATION_CONFLICT');
      }

      // Check conflict audit row was created
      const conflicts = await runWithTenant(tenantA, async () =>
        prisma.whatsAppShadowRatingConflict.findMany({
          where: { campaignRecipientId: recipient.id },
        }),
      );
      expect(conflicts.length).toBe(1);
      expect(conflicts[0].shadowRatingId).toBe(original.shadowRating?.id);

      // Original row must remain unchanged
      const persisted = await runWithTenant(tenantA, () =>
        service.getShadowRatingForRecipient(recipient.id),
      );
      expect(persisted?.destination).toBe('+919876543221');
      expect(persisted?.legacyCustomerChargePaise).toBe('85');
    });
  });

  describe('3. Tenant Isolation', () => {
    it('prevents tenant B from shadow rating tenant A recipient', async () => {
      const recipientA = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        contactId: contactAId,
        destination: '+919876543230',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.isolation.1',
        providerCategory: 'utility',
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      const crossTenantResult = await runWithTenant(tenantB, () =>
        service.rateRecipientSafely(recipientA.id),
      );

      expect(crossTenantResult.recorded).toBe(false);
      if (!crossTenantResult.recorded) {
        expect(crossTenantResult.reason).toBe('RECIPIENT_NOT_FOUND');
      }
    });
  });

  describe('4. Campaign Aggregate Shadow Reconciliation', () => {
    it('computes campaign reconciliation with single unrounded wholesale sum and 25% markup', async () => {
      // Create a fresh campaign with 3 recipients:
      // Recipient 1: utility (12,500,000 micro-paise = 12.5 paise), legacy charge = 85 paise
      // Recipient 2: utility (12,500,000 micro-paise = 12.5 paise), legacy charge = 85 paise
      // Recipient 3: non-billable (0 micro-paise), legacy charge = 85 paise
      const campaign = await runWithTenant(tenantA, async () =>
        prisma.campaign.create({
          data: {
            tenantId: tenantA,
            name: 'Reconciliation Test Campaign',
            channel: Channel.WHATSAPP,
            status: 'sending',
            createdBy: testUserId,
          },
        }),
      );

      const r1 = await createRecipient({
        tenantId: tenantA,
        campaignId: campaign.id,
        contactId: contactAId,
        destination: '+919876543241',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.recon.1',
        providerCategory: 'utility',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      const r2 = await createRecipient({
        tenantId: tenantA,
        campaignId: campaign.id,
        contactId: contactAId,
        destination: '+919876543242',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.recon.2',
        providerCategory: 'utility',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      const r3 = await createRecipient({
        tenantId: tenantA,
        campaignId: campaign.id,
        contactId: contactAId,
        destination: '+919876543243',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.recon.3',
        providerCategory: 'utility',
        providerBillable: false, // non-billable
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      // Rate all 3
      await runWithTenant(tenantA, () => service.rateRecipientSafely(r1.id));
      await runWithTenant(tenantA, () => service.rateRecipientSafely(r2.id));
      await runWithTenant(tenantA, () => service.rateRecipientSafely(r3.id));

      // Reconcile campaign
      const recon = await runWithTenant(tenantA, () =>
        service.reconcileCampaign(campaign.id),
      );

      expect(recon.totalRecipients).toBe(3);
      expect(recon.eligibleRecipients).toBe(3);
      expect(recon.ratedRecipients).toBe(2);
      expect(recon.nonBillableRecipients).toBe(1);
      expect(recon.unratedRecipients).toBe(0);
      expect(recon.status).toBe('COMPLETE');
      expect(recon.isFinal).toBe(true);
      expect(recon.version).toBe(1);

      // Wholesale total = 12,500,000 + 12,500,000 = 25,000,000 micro-paise (= 25.00 paise)
      expect(recon.totalProviderCostMicroPaise).toBe('25000000');

      // 25% markup = ceil(25,000,000 * 2500 / 10000) = 6,250,000 micro-paise (= 6.25 paise)
      expect(recon.markupAmountMicroPaise).toBe('6250000');

      // Retail total micro-paise = 25,000,000 + 6,250,000 = 31,250,000 micro-paise (= 31.25 paise)
      expect(recon.retailAmountMicroPaise).toBe('31250000');

      // Rated shadow total paise = ceil(31,250,000 / 1,000,000) = 32 paise!
      expect(recon.ratedShadowTotalPaise).toBe('32');

      // Safeguard 5: Non-billable is economically resolved; legacy charge included in resolved legacy total:
      // Legacy total for all economically resolved = 85 + 85 + 85 = 255 paise
      expect(recon.ratedLegacyTotalPaise).toBe('255');

      // Signed difference = 32 - 255 = -223 paise
      expect(recon.signedDifferencePaise).toBe('-223');

      // Variance bps = round((-223 * 10000) / 255) = -8745 bps
      expect(recon.varianceBps).toBe(-8745);
    });

    it('marks campaign reconciliation PARTIAL when some recipients remain unrated', async () => {
      const campaign = await runWithTenant(tenantA, async () =>
        prisma.campaign.create({
          data: {
            tenantId: tenantA,
            name: 'Partial Recon Campaign',
            channel: Channel.WHATSAPP,
            status: 'sending',
            createdBy: testUserId,
          },
        }),
      );

      const r1 = await createRecipient({
        tenantId: tenantA,
        campaignId: campaign.id,
        destination: '+919876543251',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.partial.1',
        providerCategory: 'utility',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      // Recipient 2 reached the send stage but hasn't received a rating yet (eligible but unrated)
      await createRecipient({
        tenantId: tenantA,
        campaignId: campaign.id,
        destination: '+919876543252',
        status: RecipientStatus.SENT,
        provider: 'meta',
        providerMessageId: 'wamid.partial.2',
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      // Rate only r1
      await runWithTenant(tenantA, () => service.rateRecipientSafely(r1.id));

      const recon = await runWithTenant(tenantA, () =>
        service.reconcileCampaign(campaign.id),
      );

      expect(recon.totalRecipients).toBe(2);
      expect(recon.eligibleRecipients).toBe(2);
      expect(recon.ratedRecipients).toBe(1);
      expect(recon.unratedRecipients).toBe(1);
      expect(recon.status).toBe('PARTIAL');
      expect(recon.isFinal).toBe(false);
      expect(recon.version).toBe(1);
    });

    it('excludes pre-send skipped and pre-send failed recipients from eligible population and achieves isFinal = true', async () => {
      const campaign = await runWithTenant(tenantA, async () =>
        prisma.campaign.create({
          data: {
            tenantId: tenantA,
            name: 'Safeguard 1 Eligible Population Campaign',
            channel: Channel.WHATSAPP,
            status: 'completed',
            createdBy: testUserId,
          },
        }),
      );

      // 1. Authoritative sent/delivered recipient (eligible & will be rated)
      const r1 = await createRecipient({
        tenantId: tenantA,
        campaignId: campaign.id,
        destination: '+919876543253',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.eligible.1',
        providerCategory: 'utility',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      // 2. Skipped opted-out recipient (ineligible)
      await createRecipient({
        tenantId: tenantA,
        campaignId: campaign.id,
        destination: '+919876543254',
        status: RecipientStatus.SKIPPED_OPTED_OUT,
        sentAt: null,
      });

      // 3. Skipped insufficient funds recipient (ineligible)
      await createRecipient({
        tenantId: tenantA,
        campaignId: campaign.id,
        destination: '+919876543255',
        status: RecipientStatus.SKIPPED_INSUFFICIENT_FUNDS,
        sentAt: null,
      });

      // 4. Failed before provider acceptance (ineligible)
      await createRecipient({
        tenantId: tenantA,
        campaignId: campaign.id,
        destination: '+919876543256',
        status: RecipientStatus.FAILED,
        sentAt: null,
      });

      // Rate only the 1 eligible recipient
      await runWithTenant(tenantA, () => service.rateRecipientSafely(r1.id));

      const recon = await runWithTenant(tenantA, () =>
        service.reconcileCampaign(campaign.id),
      );

      // Total recipients = 4, but eligible = 1!
      expect(recon.totalRecipients).toBe(4);
      expect(recon.eligibleRecipients).toBe(1);
      expect(recon.ratedRecipients).toBe(1);
      expect(recon.unratedRecipients).toBe(0);
      expect(recon.status).toBe('COMPLETE');
      expect(recon.isFinal).toBe(true);
    });

    it('enforces version idempotency: unchanged reconciliation returns existing version, changed reconciliation appends version + 1', async () => {
      const campaign = await runWithTenant(tenantA, async () =>
        prisma.campaign.create({
          data: {
            tenantId: tenantA,
            name: 'Version Idempotency Campaign',
            channel: Channel.WHATSAPP,
            status: 'sending',
            createdBy: testUserId,
          },
        }),
      );

      const r1 = await createRecipient({
        tenantId: tenantA,
        campaignId: campaign.id,
        destination: '+919876543257',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.version.1',
        providerCategory: 'utility',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      const r2 = await createRecipient({
        tenantId: tenantA,
        campaignId: campaign.id,
        destination: '+919876543258',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.version.2',
        providerCategory: 'utility',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      // Rate r1
      await runWithTenant(tenantA, () => service.rateRecipientSafely(r1.id));

      // First reconciliation -> allocates version 1
      const recon1 = await runWithTenant(tenantA, () =>
        service.reconcileCampaign(campaign.id),
      );
      expect(recon1.version).toBe(1);
      expect(recon1.status).toBe('PARTIAL');

      // Idempotent duplicate call (e.g. repeated delivery webhook) with unchanged state -> returns existing v1
      const recon1Replay = await runWithTenant(tenantA, () =>
        service.reconcileCampaign(campaign.id),
      );
      expect(recon1Replay.version).toBe(1);
      expect(recon1Replay.id).toBe(recon1.id);

      // Now rate r2 (state changes)
      await runWithTenant(tenantA, () => service.rateRecipientSafely(r2.id));

      // Third reconciliation -> detects state change and appends version 2
      const recon2 = await runWithTenant(tenantA, () =>
        service.reconcileCampaign(campaign.id),
      );
      expect(recon2.version).toBe(2);
      expect(recon2.status).toBe('COMPLETE');
      expect(recon2.isFinal).toBe(true);
      expect(recon2.id).not.toBe(recon1.id);
    });

    it('evaluates campaign activation readiness: requires latest reconciliation isFinal = true AND durable conflicts = 0', async () => {
      const campaign = await runWithTenant(tenantA, async () =>
        prisma.campaign.create({
          data: {
            tenantId: tenantA,
            name: 'Activation Readiness Campaign',
            channel: Channel.WHATSAPP,
            status: 'sending',
            createdBy: testUserId,
          },
        }),
      );

      const r1 = await createRecipient({
        tenantId: tenantA,
        campaignId: campaign.id,
        destination: '+919876543259',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.activation.1',
        providerCategory: 'utility',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      // 1. Before reconciliation: readiness fails (no snapshot)
      const readinessPreRecon = await runWithTenant(tenantA, () =>
        service.evaluateCampaignActivationReadiness(campaign.id),
      );
      expect(readinessPreRecon.ready).toBe(false);
      expect(readinessPreRecon.blockingReasons).toContain(
        'No reconciliation snapshot exists for this campaign.',
      );

      // Rate r1 and reconcile
      await runWithTenant(tenantA, () => service.rateRecipientSafely(r1.id));
      await runWithTenant(tenantA, () => service.reconcileCampaign(campaign.id));

      // 2. All eligible recipients resolved and zero conflicts -> ready = true
      const readinessPostRecon = await runWithTenant(tenantA, () =>
        service.evaluateCampaignActivationReadiness(campaign.id),
      );
      expect(readinessPostRecon.ready).toBe(true);
      expect(readinessPostRecon.isFinal).toBe(true);
      expect(readinessPostRecon.conflictCount).toBe(0);
      expect(readinessPostRecon.blockingReasons).toEqual([]);

      // 3. Simulate conflicting replay write to WhatsAppShadowRatingConflict
      const rating = await runWithTenant(tenantA, () =>
        service.getShadowRatingForRecipient(r1.id),
      );
      await runWithTenant(tenantA, async () =>
        prisma.whatsAppShadowRatingConflict.create({
          data: {
            tenantId: tenantA,
            campaignRecipientId: r1.id,
            shadowRatingId: rating!.id,
            reason: 'RECONCILIATION_CONFLICT',
            incomingValues: { destination: '+919999999999' },
            existingValues: { destination: '+919876543259' },
          },
        }),
      );

      // 4. With durable conflicts > 0 -> readiness fails closed even though isFinal was true
      const readinessWithConflict = await runWithTenant(tenantA, () =>
        service.evaluateCampaignActivationReadiness(campaign.id),
      );
      expect(readinessWithConflict.ready).toBe(false);
      expect(readinessWithConflict.conflictCount).toBe(1);
      expect(readinessWithConflict.blockingReasons.some((r) => r.includes('conflicts detected'))).toBe(true);
    });
  });

  describe('5. Longest-Prefix Destination Matching', () => {
    it('matches more specific prefix 9198 over general 91', async () => {
      // Upsert specific rate for 9198: 9,000,000 micro-paise (9.0 paise)
      await rateCatalog.upsertRate({
        provider: 'meta',
        channel: Channel.WHATSAPP,
        destinationPattern: '9198',
        category: 'utility',
        unit: 'message',
        rateMicroPaise: 9_000_000n,
        currency: 'INR',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      });

      const recipient = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+919876543260',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.lpm.1',
        providerCategory: 'utility',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      const result = await runWithTenant(tenantA, () =>
        service.rateRecipientSafely(recipient.id),
      );

      expect(result.recorded).toBe(true);
      expect(result.shadowRating?.rateMicroPaise).toBe('9000000');
    });
  });

  describe('6. Channel Validation & Non-WhatsApp Rejection', () => {
    it('rejects shadow rating for recipient belonging to an EMAIL campaign', async () => {
      const emailCampaign = await runWithTenant(tenantA, async () =>
        prisma.campaign.create({
          data: {
            tenantId: tenantA,
            name: 'Email Campaign',
            channel: Channel.EMAIL,
            status: 'queued',
            createdBy: testUserId,
          },
        }),
      );

      const emailRecipient = await createRecipient({
        tenantId: tenantA,
        campaignId: emailCampaign.id,
        destination: 'user@example.com',
        status: RecipientStatus.SENT,
        provider: 'ses',
        costPaise: 10n,
      });

      const result = await runWithTenant(tenantA, () =>
        service.rateRecipientSafely(emailRecipient.id),
      );

      expect(result.recorded).toBe(false);
      if (!result.recorded) {
        expect(result.reason).toBe('CHANNEL_MISMATCH');
      }
    });
  });

  describe('7. Zero Customer Wallet Charging Mutation Invariant', () => {
    it('verifies that shadow rating creates ZERO wallet transactions and leaves balances untouched', async () => {
      // Fetch initial wallet and transactions
      const initialWallet = await runWithTenant(tenantA, async () =>
        prisma.wallet.findUnique({ where: { tenantId: tenantA } }),
      );
      const initialTxCount = await runWithTenant(tenantA, async () =>
        prisma.walletTransaction.count({ where: { tenantId: tenantA } }),
      );

      // Perform multiple shadow ratings
      const recipient = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+919876543270',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.wallet.test.1',
        providerCategory: 'utility',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 85n,
      });

      await runWithTenant(tenantA, () => service.rateRecipientSafely(recipient.id));
      await runWithTenant(tenantA, () => service.reconcileCampaign(campaignAId));

      const finalWallet = await runWithTenant(tenantA, async () =>
        prisma.wallet.findUnique({ where: { tenantId: tenantA } }),
      );
      const finalTxCount = await runWithTenant(tenantA, async () =>
        prisma.walletTransaction.count({ where: { tenantId: tenantA } }),
      );

      expect(finalWallet?.balancePaise).toBe(initialWallet?.balancePaise);
      expect(finalTxCount).toBe(initialTxCount);
    });
  });

  describe('8. Critical Financial Math & Large-Scale Aggregation Safeguards', () => {
    it('handles single recipient monetary value greater than Number.MAX_SAFE_INTEGER with zero IEEE-754 precision loss', async () => {
      const campaignLarge = await runWithTenant(tenantA, async () =>
        prisma.campaign.create({
          data: {
            tenantId: tenantA,
            name: 'Large BigInt Campaign',
            channel: Channel.WHATSAPP,
            status: 'queued',
            createdBy: testUserId,
          },
        }),
      );

      const recipient = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignLarge.id,
        destination: '+447123456780',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.large.1',
        providerCategory: 'large-bigint',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 10_000_000_000n,
      });

      const result = await runWithTenant(tenantA, () => service.rateRecipientSafely(recipient.id));
      expect(result.recorded).toBe(true);
      expect(result.shadowRating?.rateMicroPaise).toBe('12345678901234567');
      expect(result.shadowRating?.providerCostMicroPaise).toBe('12345678901234567');

      // Verify > Number.MAX_SAFE_INTEGER
      const val = BigInt(result.shadowRating!.providerCostMicroPaise!);
      expect(val > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
      // In IEEE-754 double, 12345678901234567 loses precision and becomes 12345678901234568
      expect(Number(val).toString()).not.toBe('12345678901234567');

      const reconciliation = await runWithTenant(tenantA, () =>
        service.reconcileCampaign(campaignLarge.id),
      );

      // Calculations:
      // wholesale = 12_345_678_901_234_567n
      // markup (25%) = (12345678901234567n * 2500n + 9999n) / 10000n = 3_086_419_725_308_641n
      // retail = 12345678901234567n + 3086419725308641n = 15_432_098_626_543_208n
      // shadowCustomerChargePaise = ceil(15432098626543208 / 1_000_000) = 15_432_098_627n
      expect(reconciliation.totalProviderCostMicroPaise).toBe('12345678901234567');
      expect(reconciliation.markupAmountMicroPaise).toBe('3086419725308642');
      expect(reconciliation.retailAmountMicroPaise).toBe('15432098626543209');
      expect(reconciliation.ratedShadowTotalPaise).toBe('15432098627');
      expect(reconciliation.isFinal).toBe(true);
    });

    it('handles 1 recipient fractional-paisa cost with exact ceiling division at final settlement', async () => {
      const campaignFractional = await runWithTenant(tenantA, async () =>
        prisma.campaign.create({
          data: {
            tenantId: tenantA,
            name: 'Fractional Paisa Campaign',
            channel: Channel.WHATSAPP,
            status: 'queued',
            createdBy: testUserId,
          },
        }),
      );

      const recipient = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignFractional.id,
        destination: '+447123456781',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.frac.1',
        providerCategory: 'fractional',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 10n,
      });

      const result = await runWithTenant(tenantA, () => service.rateRecipientSafely(recipient.id));
      expect(result.recorded).toBe(true);
      expect(result.shadowRating?.rateMicroPaise).toBe('123456');

      const reconciliation = await runWithTenant(tenantA, () =>
        service.reconcileCampaign(campaignFractional.id),
      );

      // Calculations:
      // wholesale = 123_456n
      // markup (25%) = (123456n * 2500n + 9999n) / 10000n = 30_864n
      // retail = 123456n + 30864n = 154_320n
      // shadowCustomerChargePaise = ceil(154320 / 1_000_000) = 1n
      expect(reconciliation.totalProviderCostMicroPaise).toBe('123456');
      expect(reconciliation.markupAmountMicroPaise).toBe('30864');
      expect(reconciliation.retailAmountMicroPaise).toBe('154320');
      expect(reconciliation.ratedShadowTotalPaise).toBe('1');
      expect(reconciliation.isFinal).toBe(true);
    });

    it('aggregates 10,000 recipients using BigInt arithmetic only', async () => {
      const campaign10k = await runWithTenant(tenantA, async () =>
        prisma.campaign.create({
          data: {
            tenantId: tenantA,
            name: '10,000 Recipients Aggregation Campaign',
            channel: Channel.WHATSAPP,
            status: 'queued',
            createdBy: testUserId,
          },
        }),
      );

      // Server-side generate 10,000 distinct contacts in Postgres in ~50ms
      await prisma.$executeRaw`
        INSERT INTO contacts (id, tenant_id, full_name, phone, created_at, updated_at)
        SELECT
          gen_random_uuid(),
          ${tenantA}::uuid,
          'Bulk Contact ' || g,
          '+9199' || lpad(g::text, 8, '0'),
          NOW(),
          NOW()
        FROM generate_series(1, 10000) AS g;
      `;

      // Server-side generate 10,000 recipients linked 1:1 to each contact
      await prisma.$executeRaw`
        INSERT INTO campaign_recipients (
          id, tenant_id, campaign_id, contact_id, destination, status,
          provider, provider_message_id, provider_category, provider_billable,
          sent_at, cost_paise, created_at, updated_at
        )
        SELECT
          gen_random_uuid(),
          ${tenantA}::uuid,
          ${campaign10k.id}::uuid,
          c.id,
          c.phone,
          'delivered'::"RecipientStatus",
          'meta',
          'wamid.10k.' || c.phone,
          'bulk',
          true,
          NOW(),
          100,
          NOW(),
          NOW()
        FROM contacts c
        WHERE c.tenant_id = ${tenantA}::uuid AND c.phone LIKE '+9199%'
        LIMIT 10000;
      `;

      // Server-side generate 10,000 pre-rated shadow rows at 400_000 micro-paise (0.40 paise each)
      await prisma.$executeRaw`
        INSERT INTO whatsapp_shadow_ratings (
          id, tenant_id, campaign_id, campaign_recipient_id, provider,
          provider_message_id, destination, category, pricing_model,
          billable, rate_micro_paise, provider_cost_micro_paise,
          legacy_customer_charge_paise, status, cost_source,
          occurred_at, rated_at, created_at
        )
        SELECT
          gen_random_uuid(),
          cr.tenant_id,
          cr.campaign_id,
          cr.id,
          'meta',
          cr.provider_message_id,
          cr.destination,
          'bulk',
          NULL,
          true,
          400000,
          400000,
          100,
          'RATED',
          'RATE_CATALOG',
          NOW(),
          NOW(),
          NOW()
        FROM campaign_recipients cr
        WHERE cr.campaign_id = ${campaign10k.id}::uuid;
      `;

      const reconciliation = await runWithTenant(tenantA, () =>
        service.reconcileCampaign(campaign10k.id),
      );

      // Math:
      // wholesale = 10,000 * 400_000 = 4_000_000_000n
      // markup (25%) = 1_000_000_000n
      // retail = 5_000_000_000n
      // shadow customer charge = 5_000_000_000 / 1_000_000 = 5_000n paise
      // legacy total = 10,000 * 100n = 1_000_000n paise
      // difference = 5_000n - 1_000_000n = -995_000n paise
      expect(reconciliation.totalRecipients).toBe(10000);
      expect(reconciliation.eligibleRecipients).toBe(10000);
      expect(reconciliation.ratedRecipients).toBe(10000);
      expect(reconciliation.unratedRecipients).toBe(0);
      expect(reconciliation.nonBillableRecipients).toBe(0);
      expect(reconciliation.totalProviderCostMicroPaise).toBe('4000000000');
      expect(reconciliation.markupAmountMicroPaise).toBe('1000000000');
      expect(reconciliation.retailAmountMicroPaise).toBe('5000000000');
      expect(reconciliation.ratedShadowTotalPaise).toBe('5000');
      expect(reconciliation.ratedLegacyTotalPaise).toBe('1000000');
      expect(reconciliation.signedDifferencePaise).toBe('-995000');
      expect(reconciliation.isFinal).toBe(true);
      expect(reconciliation.status).toBe('COMPLETE');
    }, 30_000);

    it('aggregates very large BigInt totals exceeding Number.MAX_SAFE_INTEGER without overflow or precision loss', async () => {
      const campaignVeryLarge = await runWithTenant(tenantA, async () =>
        prisma.campaign.create({
          data: {
            tenantId: tenantA,
            name: 'Very Large BigInt Aggregate Campaign',
            channel: Channel.WHATSAPP,
            status: 'queued',
            createdBy: testUserId,
          },
        }),
      );

      const r1 = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignVeryLarge.id,
        destination: '+919776543881',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        sentAt: new Date('2026-06-01T12:00:00Z'),
        costPaise: 1_000_000_000_000n,
      });

      const r2 = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignVeryLarge.id,
        destination: '+919776543882',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        sentAt: new Date('2026-06-01T12:00:00Z'),
        costPaise: 1_000_000_000_000n,
      });

      // Insert 2 shadow ratings of 2.5 * 10^18 micro-paise each (total = 5 * 10^18 micro-paise)
      // Note: 5 * 10^18 is ~555x larger than Number.MAX_SAFE_INTEGER (9 * 10^15) and fits within Postgres 64-bit BIGINT (9.22 * 10^18)
      await runWithTenant(tenantA, async () => {
        await prisma.whatsAppShadowRating.createMany({
          data: [
            {
              tenantId: tenantA,
              campaignId: campaignVeryLarge.id,
              campaignRecipientId: r1.id,
              provider: 'meta',
              destination: r1.destination,
              billable: true,
              rateMicroPaise: 2_500_000_000_000_000_000n,
              providerCostMicroPaise: 2_500_000_000_000_000_000n,
              legacyCustomerChargePaise: 1_000_000_000_000n,
              status: 'RATED',
              occurredAt: new Date('2026-06-01T12:00:00Z'),
              ratedAt: new Date(),
            },
            {
              tenantId: tenantA,
              campaignId: campaignVeryLarge.id,
              campaignRecipientId: r2.id,
              provider: 'meta',
              destination: r2.destination,
              billable: true,
              rateMicroPaise: 2_500_000_000_000_000_000n,
              providerCostMicroPaise: 2_500_000_000_000_000_000n,
              legacyCustomerChargePaise: 1_000_000_000_000n,
              status: 'RATED',
              occurredAt: new Date('2026-06-01T12:00:00Z'),
              ratedAt: new Date(),
            },
          ],
        });
      });

      const reconciliation = await runWithTenant(tenantA, () =>
        service.reconcileCampaign(campaignVeryLarge.id),
      );

      // Calculations:
      // wholesale = 5_000_000_000_000_000_000n (5 * 10^18)
      // markup (25%) = 1_250_000_000_000_000_000n
      // retail = 6_250_000_000_000_000_000n
      // shadowCustomerChargePaise = ceil(6_250_000_000_000_000_000 / 1_000_000) = 6_250_000_000_000n
      // legacy total = 2_000_000_000_000n
      // signed diff = 4_250_000_000_000n
      expect(reconciliation.totalProviderCostMicroPaise).toBe('5000000000000000000');
      expect(reconciliation.markupAmountMicroPaise).toBe('1250000000000000000');
      expect(reconciliation.retailAmountMicroPaise).toBe('6250000000000000000');
      expect(reconciliation.ratedShadowTotalPaise).toBe('6250000000000');
      expect(reconciliation.ratedLegacyTotalPaise).toBe('2000000000000');
      expect(reconciliation.signedDifferencePaise).toBe('4250000000000');
      expect(reconciliation.isFinal).toBe(true);
      expect(reconciliation.status).toBe('COMPLETE');
    });

    it('aggregates zero-cost NON_BILLABLE population with 0n shadow charges and preserves legacy totals', async () => {
      const campaignNonBillable = await runWithTenant(tenantA, async () =>
        prisma.campaign.create({
          data: {
            tenantId: tenantA,
            name: 'Zero Cost Non-Billable Campaign',
            channel: Channel.WHATSAPP,
            status: 'queued',
            createdBy: testUserId,
          },
        }),
      );

      for (let i = 1; i <= 3; i++) {
        const r = await createRecipient({
          tenantId: tenantA,
          campaignId: campaignNonBillable.id,
          destination: `+91977654390${i}`,
          status: RecipientStatus.DELIVERED,
          provider: 'meta',
          providerMessageId: `wamid.nb.${i}`,
          providerCategory: 'utility',
          providerBillable: false,
          sentAt: new Date('2026-06-01T10:00:00Z'),
          costPaise: 120n,
        });
        const result = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
        expect(result.recorded).toBe(true);
        expect(result.shadowRating?.status).toBe('NON_BILLABLE');
        expect(result.shadowRating?.providerCostMicroPaise).toBe('0');
      }

      const reconciliation = await runWithTenant(tenantA, () =>
        service.reconcileCampaign(campaignNonBillable.id),
      );

      expect(reconciliation.eligibleRecipients).toBe(3);
      expect(reconciliation.ratedRecipients).toBe(0);
      expect(reconciliation.nonBillableRecipients).toBe(3);
      expect(reconciliation.totalProviderCostMicroPaise).toBe('0');
      expect(reconciliation.markupAmountMicroPaise).toBe('0');
      expect(reconciliation.retailAmountMicroPaise).toBe('0');
      expect(reconciliation.ratedShadowTotalPaise).toBe('0');
      expect(reconciliation.ratedLegacyTotalPaise).toBe('360');
      expect(reconciliation.signedDifferencePaise).toBe('-360');
      expect(reconciliation.isFinal).toBe(true);
      expect(reconciliation.status).toBe('COMPLETE');
    });

    it('aggregates mixed RATED + NON_BILLABLE population with exact fractional markup and ceiling division', async () => {
      const campaignMixed = await runWithTenant(tenantA, async () =>
        prisma.campaign.create({
          data: {
            tenantId: tenantA,
            name: 'Mixed Rated and Non-Billable Campaign',
            channel: Channel.WHATSAPP,
            status: 'queued',
            createdBy: testUserId,
          },
        }),
      );

      // 3 RATED recipients at 12_500_000 micro-paise each (general 91 utility rate, avoiding 9198 prefix)
      for (let i = 1; i <= 3; i++) {
        const r = await createRecipient({
          tenantId: tenantA,
          campaignId: campaignMixed.id,
          destination: `+9197654391${i}`,
          status: RecipientStatus.DELIVERED,
          provider: 'meta',
          providerMessageId: `wamid.mix.rated.${i}`,
          providerCategory: 'utility',
          providerBillable: true,
          sentAt: new Date('2026-06-01T10:00:00Z'),
          costPaise: 100n,
        });
        const result = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
        expect(result.recorded).toBe(true);
        expect(result.shadowRating?.status).toBe('RATED');
      }

      // 2 NON_BILLABLE recipients
      for (let i = 1; i <= 2; i++) {
        const r = await createRecipient({
          tenantId: tenantA,
          campaignId: campaignMixed.id,
          destination: `+9197654392${i}`,
          status: RecipientStatus.DELIVERED,
          provider: 'meta',
          providerMessageId: `wamid.mix.nb.${i}`,
          providerCategory: 'utility',
          providerBillable: false,
          sentAt: new Date('2026-06-01T10:00:00Z'),
          costPaise: 100n,
        });
        const result = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
        expect(result.recorded).toBe(true);
        expect(result.shadowRating?.status).toBe('NON_BILLABLE');
      }

      const reconciliation = await runWithTenant(tenantA, () =>
        service.reconcileCampaign(campaignMixed.id),
      );

      // Calculations:
      // wholesale = 3 * 12_500_000 = 37_500_000n
      // markup (25%) = (37_500_000 * 2500 + 9999) / 10000 = 9_375_000n
      // retail = 37_500_000 + 9_375_000 = 46_875_000n
      // shadowCustomerChargePaise = ceil(46_875_000 / 1_000_000) = 47n
      // legacy = 5 * 100 = 500n
      // diff = 47 - 500 = -453n
      expect(reconciliation.eligibleRecipients).toBe(5);
      expect(reconciliation.ratedRecipients).toBe(3);
      expect(reconciliation.nonBillableRecipients).toBe(2);
      expect(reconciliation.totalProviderCostMicroPaise).toBe('37500000');
      expect(reconciliation.markupAmountMicroPaise).toBe('9375000');
      expect(reconciliation.retailAmountMicroPaise).toBe('46875000');
      expect(reconciliation.ratedShadowTotalPaise).toBe('47');
      expect(reconciliation.ratedLegacyTotalPaise).toBe('500');
      expect(reconciliation.signedDifferencePaise).toBe('-453');
      expect(reconciliation.isFinal).toBe(true);
      expect(reconciliation.status).toBe('COMPLETE');
    });

    it('enforces that NON_BILLABLE is ONLY derived from providerBillable=false, never from utility/service category or template type', async () => {
      // 1. Utility with billable=true -> RATED (using 9197 prefix to match general 91 utility rate: 12_500_000)
      const rUtilBillable = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+91976543931',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.test.cat.1',
        providerCategory: 'utility',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });
      const res1 = await runWithTenant(tenantA, () => service.rateRecipientSafely(rUtilBillable.id));
      expect(res1.shadowRating?.status).toBe('RATED');
      expect(res1.shadowRating?.rateMicroPaise).toBe('12500000');

      // 2. Service with billable=true -> RATED (using 9197 prefix to match general 91 service rate: 35_000_000)
      const rServiceBillable = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+91976543932',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.test.cat.2',
        providerCategory: 'service',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });
      const res2 = await runWithTenant(tenantA, () => service.rateRecipientSafely(rServiceBillable.id));
      expect(res2.shadowRating?.status).toBe('RATED');
      expect(res2.shadowRating?.rateMicroPaise).toBe('35000000');

      // 3. Utility with billable=null (unspecified) -> COST_UNAVAILABLE (BILLABLE_SIGNAL_MISSING)
      const rUtilNull = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+91976543933',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.test.cat.3',
        providerCategory: 'utility',
        providerBillable: null,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });
      const res3 = await runWithTenant(tenantA, () => service.rateRecipientSafely(rUtilNull.id));
      expect(res3.shadowRating?.status).toBe('COST_UNAVAILABLE');
      expect(res3.shadowRating?.unavailableReason).toBe('BILLABLE_SIGNAL_MISSING');
      expect(res3.shadowRating?.billable).toBeNull();

      // 4. Utility with authoritative billable=false -> NON_BILLABLE
      const rUtilNonBillable = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+91976543934',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.test.cat.4',
        providerCategory: 'utility',
        providerBillable: false,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });
      const res4 = await runWithTenant(tenantA, () => service.rateRecipientSafely(rUtilNonBillable.id));
      expect(res4.shadowRating?.status).toBe('NON_BILLABLE');
      expect(res4.shadowRating?.providerCostMicroPaise).toBe('0');

      // 5. Service with authoritative billable=false -> NON_BILLABLE
      const rServiceNonBillable = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+91976543935',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.test.cat.5',
        providerCategory: 'service',
        providerBillable: false,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });
      const res5 = await runWithTenant(tenantA, () => service.rateRecipientSafely(rServiceNonBillable.id));
      expect(res5.shadowRating?.status).toBe('NON_BILLABLE');
      expect(res5.shadowRating?.providerCostMicroPaise).toBe('0');
    });
  });

  describe('9. Recipient Shadow Rating Versioning, Enrichment vs Conflict & Nullable Billability', () => {
    it('1. providerBillable === null records COST_UNAVAILABLE with BILLABLE_SIGNAL_MISSING at ratingVersion 1', async () => {
      const r = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+91987654001',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.v.test.1',
        providerCategory: 'marketing',
        providerBillable: null,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });

      const res = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res.recorded).toBe(true);
      expect(res.shadowRating?.ratingVersion).toBe(1);
      expect(res.shadowRating?.status).toBe('COST_UNAVAILABLE');
      expect(res.shadowRating?.unavailableReason).toBe('BILLABLE_SIGNAL_MISSING');
      expect(res.shadowRating?.billable).toBeNull();
      expect(res.shadowRating?.providerCostMicroPaise).toBeNull();
    });

    it('recovers from RATE_NOT_CONFIGURED when an effective-dated ProviderRate is later added', async () => {
      const sentAt = new Date('2026-06-01T10:00:00Z');
      const r = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+819012345678',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.v.rate-catalog-recovery',
        providerCategory: 'authentication-recovery',
        providerBillable: true,
        sentAt,
        costPaise: 80n,
      });

      const res1 = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res1.shadowRating?.ratingVersion).toBe(1);
      expect(res1.shadowRating?.status).toBe('COST_UNAVAILABLE');
      expect(res1.shadowRating?.unavailableReason).toBe('RATE_NOT_CONFIGURED');

      const newRate = await rateCatalog.upsertRate({
        provider: 'meta',
        channel: Channel.WHATSAPP,
        destinationPattern: '81',
        category: 'authentication-recovery',
        unit: 'message',
        rateMicroPaise: 42_500_000n,
        currency: 'INR',
        effectiveFrom: new Date('2026-05-01T00:00:00Z'),
        effectiveTo: new Date('2026-07-01T00:00:00Z'),
      });

      const res2 = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res2.recorded).toBe(true);
      expect(res2.isDuplicate).toBe(false);
      expect(res2.shadowRating?.ratingVersion).toBe(2);
      expect(res2.shadowRating?.status).toBe('RATED');
      expect(res2.shadowRating?.providerRateId).toBe(newRate.id);
      expect(res2.shadowRating?.rateMicroPaise).toBe('42500000');
      expect(res2.shadowRating?.providerCostMicroPaise).toBe('42500000');

      const rows = await runWithTenant(tenantA, async () =>
        await prisma.whatsAppShadowRating.findMany({
          where: { campaignRecipientId: r.id },
          orderBy: { ratingVersion: 'asc' },
        }),
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].ratingVersion).toBe(1);
      expect(rows[0].status).toBe('COST_UNAVAILABLE');
      expect(rows[0].providerRateId).toBeNull();
      expect(rows[1].ratingVersion).toBe(2);
      expect(rows[1].status).toBe('RATED');
      expect(rows[1].providerRateId).toBe(newRate.id);

      const conflicts = await runWithTenant(tenantA, async () =>
        await prisma.whatsAppShadowRatingConflict.findMany({
          where: { campaignRecipientId: r.id },
        }),
      );
      expect(conflicts).toHaveLength(0);
    });

    it('2. expected enrichment (null -> true): delivery receipt with authoritative billable=true appends ratingVersion 2 as RATED', async () => {
      const r = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+91987654002',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.v.test.2',
        providerCategory: 'marketing',
        providerBillable: null,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });

      // 1st rating: null billability -> v1
      const res1 = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res1.shadowRating?.ratingVersion).toBe(1);
      expect(res1.shadowRating?.status).toBe('COST_UNAVAILABLE');

      // Provider delivery receipt enriches billable to true
      await runWithTenant(tenantA, async () =>
        await prisma.campaignRecipient.update({
          where: { id: r.id },
          data: { providerBillable: true },
        }),
      );

      // 2nd rating: enrichment appends v2
      const res2 = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res2.recorded).toBe(true);
      expect(res2.isDuplicate).toBe(false);
      expect(res2.shadowRating?.ratingVersion).toBe(2);
      expect(res2.shadowRating?.status).toBe('RATED');
      expect(res2.shadowRating?.billable).toBe(true);
      expect(res2.shadowRating?.rateMicroPaise).toBe('80000000');

      // Verify both versions exist in database
      const rows = await runWithTenant(tenantA, async () =>
        await prisma.whatsAppShadowRating.findMany({
          where: { campaignRecipientId: r.id },
          orderBy: { ratingVersion: 'asc' },
        }),
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].ratingVersion).toBe(1);
      expect(rows[0].status).toBe('COST_UNAVAILABLE');
      expect(rows[1].ratingVersion).toBe(2);
      expect(rows[1].status).toBe('RATED');

      // Verify zero conflicts recorded
      const conflicts = await runWithTenant(tenantA, async () =>
        await prisma.whatsAppShadowRatingConflict.findMany({
          where: { campaignRecipientId: r.id },
        }),
      );
      expect(conflicts).toHaveLength(0);
    });

    it('3. expected enrichment (null -> false): delivery receipt with authoritative billable=false appends ratingVersion 2 as NON_BILLABLE', async () => {
      const r = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+91987654003',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.v.test.3',
        providerCategory: 'marketing',
        providerBillable: null,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });

      const res1 = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res1.shadowRating?.ratingVersion).toBe(1);
      expect(res1.shadowRating?.status).toBe('COST_UNAVAILABLE');

      // Provider reports billable=false
      await runWithTenant(tenantA, async () =>
        await prisma.campaignRecipient.update({
          where: { id: r.id },
          data: { providerBillable: false },
        }),
      );

      const res2 = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res2.recorded).toBe(true);
      expect(res2.shadowRating?.ratingVersion).toBe(2);
      expect(res2.shadowRating?.status).toBe('NON_BILLABLE');
      expect(res2.shadowRating?.billable).toBe(false);
      expect(res2.shadowRating?.providerCostMicroPaise).toBe('0');

      // Zero conflicts recorded
      const conflicts = await runWithTenant(tenantA, async () =>
        await prisma.whatsAppShadowRatingConflict.findMany({
          where: { campaignRecipientId: r.id },
        }),
      );
      expect(conflicts).toHaveLength(0);
    });

    it('4. expected enrichment (missing category -> category): appends ratingVersion 2 as RATED', async () => {
      const r = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+91987654004',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.v.test.4',
        providerCategory: null, // missing category
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });

      const res1 = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res1.shadowRating?.ratingVersion).toBe(1);
      expect(res1.shadowRating?.status).toBe('CATEGORY_UNAVAILABLE');

      // Meta delivery receipt provides authoritative category
      await runWithTenant(tenantA, async () =>
        await prisma.campaignRecipient.update({
          where: { id: r.id },
          data: { providerCategory: 'utility' },
        }),
      );

      const res2 = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res2.recorded).toBe(true);
      expect(res2.shadowRating?.ratingVersion).toBe(2);
      expect(res2.shadowRating?.status).toBe('RATED');
      expect(res2.shadowRating?.category).toBe('utility');

      const rows = await runWithTenant(tenantA, async () =>
        await prisma.whatsAppShadowRating.findMany({
          where: { campaignRecipientId: r.id },
          orderBy: { ratingVersion: 'asc' },
        }),
      );
      expect(rows).toHaveLength(2);
    });

    it('5. expected enrichment (missing sentAt -> sentAt): appends ratingVersion 2 as RATED', async () => {
      const r = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+91987654005',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.v.test.5',
        providerCategory: 'marketing',
        providerBillable: true,
        sentAt: null, // missing sentAt
        costPaise: 80n,
      });

      const res1 = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res1.shadowRating?.ratingVersion).toBe(1);
      expect(res1.shadowRating?.status).toBe('INVALID_STATE');
      expect(res1.shadowRating?.unavailableReason).toBe('SENT_AT_MISSING');

      // Webhook provides authoritative timestamp
      await runWithTenant(tenantA, async () =>
        await prisma.campaignRecipient.update({
          where: { id: r.id },
          data: { sentAt: new Date('2026-06-01T10:00:00Z') },
        }),
      );

      const res2 = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res2.recorded).toBe(true);
      expect(res2.shadowRating?.ratingVersion).toBe(2);
      expect(res2.shadowRating?.status).toBe('RATED');
    });

    it('6. identical replay on latest version returns existing version without allocating duplicate', async () => {
      const r = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+91987654006',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.v.test.6',
        providerCategory: 'marketing',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });

      const res1 = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res1.shadowRating?.ratingVersion).toBe(1);

      // Identical replay
      const res2 = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res2.recorded).toBe(true);
      expect(res2.isDuplicate).toBe(true);
      expect(res2.conflict).toBe(false);
      expect(res2.shadowRating?.ratingVersion).toBe(1);

      const rows = await runWithTenant(tenantA, async () =>
        await prisma.whatsAppShadowRating.findMany({
          where: { campaignRecipientId: r.id },
        }),
      );
      expect(rows).toHaveLength(1);
    });

    it('7. contradictory conflict (true -> false): records conflict, leaves original row untouched, does NOT create version 2', async () => {
      const r = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+91987654007',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.v.test.7',
        providerCategory: 'marketing',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });

      const res1 = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res1.shadowRating?.ratingVersion).toBe(1);
      expect(res1.shadowRating?.status).toBe('RATED');

      // Replay claims billable=false contradictory to already-authoritative billable=true
      await runWithTenant(tenantA, async () =>
        await prisma.campaignRecipient.update({
          where: { id: r.id },
          data: { providerBillable: false },
        }),
      );

      const res2 = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res2.recorded).toBe(false);
      expect(res2.isDuplicate).toBe(true);
      expect(res2.conflict).toBe(true);
      expect((res2 as any).reason).toBe('RECONCILIATION_CONFLICT');

      // Original row must remain completely untouched
      const rows = await runWithTenant(tenantA, async () =>
        await prisma.whatsAppShadowRating.findMany({
          where: { campaignRecipientId: r.id },
        }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].ratingVersion).toBe(1);
      expect(rows[0].status).toBe('RATED');
      expect(rows[0].billable).toBe(true);

      // Conflict logged in audit table
      const conflicts = await runWithTenant(tenantA, async () =>
        await prisma.whatsAppShadowRatingConflict.findMany({
          where: { campaignRecipientId: r.id },
        }),
      );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].reason).toBe('RECONCILIATION_CONFLICT');
    });

    it('8. contradictory conflict (false -> true): records conflict and leaves original row unmutated', async () => {
      const r = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+91987654008',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.v.test.8',
        providerCategory: 'marketing',
        providerBillable: false,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });

      const res1 = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res1.shadowRating?.ratingVersion).toBe(1);
      expect(res1.shadowRating?.status).toBe('NON_BILLABLE');

      // Contradictory change
      await runWithTenant(tenantA, async () =>
        await prisma.campaignRecipient.update({
          where: { id: r.id },
          data: { providerBillable: true },
        }),
      );

      const res2 = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res2.recorded).toBe(false);
      expect(res2.conflict).toBe(true);

      const rows = await runWithTenant(tenantA, async () =>
        await prisma.whatsAppShadowRating.findMany({
          where: { campaignRecipientId: r.id },
        }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('NON_BILLABLE');
    });

    it('9. contradictory regression (RATED replay with billable=null): records conflict and leaves row untouched', async () => {
      const r = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+91987654009',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.v.test.9',
        providerCategory: 'marketing',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });

      await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));

      // Regression: billable becomes null
      await runWithTenant(tenantA, async () =>
        await prisma.campaignRecipient.update({
          where: { id: r.id },
          data: { providerBillable: null },
        }),
      );

      const res = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res.recorded).toBe(false);
      expect(res.conflict).toBe(true);
    });

    it('10. contradictory change to destination records conflict and leaves row unmutated', async () => {
      const r = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+91987654010',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.v.test.10',
        providerCategory: 'marketing',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });

      await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));

      // Contradictory destination change
      await runWithTenant(tenantA, async () =>
        await prisma.campaignRecipient.update({
          where: { id: r.id },
          data: { destination: '+91987654999' },
        }),
      );

      const res = await runWithTenant(tenantA, () => service.rateRecipientSafely(r.id));
      expect(res.recorded).toBe(false);
      expect(res.conflict).toBe(true);
    });

    it('11. concurrent shadow rating executions for the same recipient serialize via advisory lock', async () => {
      const r = await createRecipient({
        tenantId: tenantA,
        campaignId: campaignAId,
        destination: '+91987654011',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.v.test.11',
        providerCategory: 'marketing',
        providerBillable: true,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });

      // Fire 5 concurrent rating calls for same recipient
      const results = await Promise.all([
        runWithTenant(tenantA, () => service.rateRecipientSafely(r.id)),
        runWithTenant(tenantA, () => service.rateRecipientSafely(r.id)),
        runWithTenant(tenantA, () => service.rateRecipientSafely(r.id)),
        runWithTenant(tenantA, () => service.rateRecipientSafely(r.id)),
        runWithTenant(tenantA, () => service.rateRecipientSafely(r.id)),
      ]);

      // All calls succeed
      for (const res of results) {
        expect(res.recorded).toBe(true);
      }

      // Exactly 1 new row created at version 1
      const createdCount = results.filter((res) => !res.isDuplicate).length;
      expect(createdCount).toBe(1);

      const rows = await runWithTenant(tenantA, async () =>
        await prisma.whatsAppShadowRating.findMany({
          where: { campaignRecipientId: r.id },
        }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].ratingVersion).toBe(1);
    });

    it('12. campaign reconciliation queries latest recipient version strictly once, recovers coverage from <100% to 100%, and transitions isFinal to true', async () => {
      const multiVersionCamp = await runWithTenant(tenantA, async () =>
        await prisma.campaign.create({
          data: {
            tenantId: tenantA,
            name: 'Phase 5 Multi-Version Reconciliation Campaign',
            channel: Channel.WHATSAPP,
            status: 'completed',
            createdBy: testUserId,
          },
        }),
      );

      // Recipient 1: initially missing billability (v1: COST_UNAVAILABLE)
      const r1 = await createRecipient({
        tenantId: tenantA,
        campaignId: multiVersionCamp.id,
        destination: '+91987654021',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.mv.1',
        providerCategory: 'marketing',
        providerBillable: null,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });

      // Recipient 2: authoritative non-billable (v1: NON_BILLABLE, providerCost = 0n)
      const r2 = await createRecipient({
        tenantId: tenantA,
        campaignId: multiVersionCamp.id,
        destination: '+91987654022',
        status: RecipientStatus.DELIVERED,
        provider: 'meta',
        providerMessageId: 'wamid.mv.2',
        providerCategory: 'marketing',
        providerBillable: false,
        sentAt: new Date('2026-06-01T10:00:00Z'),
        costPaise: 80n,
      });

      // Rate both initially
      await runWithTenant(tenantA, () => service.rateRecipientSafely(r1.id));
      await runWithTenant(tenantA, () => service.rateRecipientSafely(r2.id));

      // Reconcile v1: 1 of 2 eligible resolved -> isFinal = false, status = PARTIAL
      const recon1 = await runWithTenant(tenantA, () =>
        service.reconcileCampaign(multiVersionCamp.id),
      );
      expect(recon1.version).toBe(1);
      expect(recon1.totalRecipients).toBe(2);
      expect(recon1.eligibleRecipients).toBe(2);
      expect(recon1.ratedRecipients).toBe(0);
      expect(recon1.nonBillableRecipients).toBe(1);
      expect(recon1.unratedRecipients).toBe(1);
      expect(recon1.isFinal).toBe(false);
      expect(recon1.status).toBe('PARTIAL');

      // Readiness before enrichment is false
      const readiness1 = await runWithTenant(tenantA, () =>
        service.evaluateCampaignActivationReadiness(multiVersionCamp.id),
      );
      expect(readiness1.ready).toBe(false);
      expect(readiness1.blockingReasons.length).toBeGreaterThan(0);

      // Now enrich Recipient 1: delivery receipt arrives with billable=true
      await runWithTenant(tenantA, async () =>
        await prisma.campaignRecipient.update({
          where: { id: r1.id },
          data: { providerBillable: true },
        }),
      );

      const r1Enriched = await runWithTenant(tenantA, () =>
        service.rateRecipientSafely(r1.id),
      );
      expect(r1Enriched.shadowRating?.ratingVersion).toBe(2);
      expect(r1Enriched.shadowRating?.status).toBe('RATED');

      // Verify Recipient 1 has BOTH v1 and v2 in the database
      const r1Rows = await runWithTenant(tenantA, async () =>
        await prisma.whatsAppShadowRating.findMany({
          where: { campaignRecipientId: r1.id },
          orderBy: { ratingVersion: 'asc' },
        }),
      );
      expect(r1Rows).toHaveLength(2);

      // Reconcile v2: queries DISTINCT ON (campaign_recipient_id) latest version only!
      const recon2 = await runWithTenant(tenantA, () =>
        service.reconcileCampaign(multiVersionCamp.id),
      );
      expect(recon2.version).toBe(2);
      expect(recon2.totalRecipients).toBe(2);
      expect(recon2.eligibleRecipients).toBe(2);
      expect(recon2.ratedRecipients).toBe(1);
      expect(recon2.nonBillableRecipients).toBe(1);
      expect(recon2.unratedRecipients).toBe(0);
      expect(recon2.isFinal).toBe(true);
      expect(recon2.status).toBe('COMPLETE');

      // Verify financial aggregation uses latest version strictly once:
      // r1 latest v2 rate: 80_000_000 micro-paise
      // r2 latest v1 rate: 0 micro-paise (NON_BILLABLE)
      // Total provider cost = 80_000_000n (never doubled!)
      expect(recon2.totalProviderCostMicroPaise).toBe('80000000');
      // Markup 25% = 20_000_000n
      expect(recon2.markupAmountMicroPaise).toBe('20000000');
      // Retail = 100_000_000n
      expect(recon2.retailAmountMicroPaise).toBe('100000000');
      // Shadow total paise = ceil(100_000_000 / 1_000_000) = 100 paise
      expect(recon2.ratedShadowTotalPaise).toBe('100');
      // Resolved legacy total paise = 80 + 80 = 160 paise (never doubled!)
      expect(recon2.ratedLegacyTotalPaise).toBe('160');
      expect(recon2.signedDifferencePaise).toBe('-60');

      // Activation readiness evaluates to true
      const readiness2 = await runWithTenant(tenantA, () =>
        service.evaluateCampaignActivationReadiness(multiVersionCamp.id),
      );
      expect(readiness2.ready).toBe(true);
      expect(readiness2.isFinal).toBe(true);
      expect(readiness2.reconciliationVersion).toBe(2);
      expect(readiness2.reconciliationStatus).toBe('COMPLETE');
      expect(readiness2.conflictCount).toBe(0);
      expect(readiness2.blockingReasons).toHaveLength(0);
    });
  });
});
