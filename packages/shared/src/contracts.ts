/**
 * API contract types — the shapes crossing the HTTP boundary.
 *
 * The Next.js dashboard imports these so a change to a response shape is a
 * compile error in the UI rather than a runtime surprise.
 *
 * Money is always a `MoneyDto`, never a bare number (spec §9.1).
 */

import type { MoneyDto } from './money';
import type { Permission } from './permissions';
import type { Role } from './roles';
import type {
  BalanceBucket,
  CallDirection,
  CallOutcome,
  CallStatus,
  CampaignStatus,
  Channel,
  CommunicationEventType,
  EventDirection,
  InviteStatus,
  LowBalanceBehavior,
  RecipientStatus,
  TemplateStatus,
  TenantStatus,
  TranscriptSpeaker,
  UsageEventType,
  WalletTransactionType,
} from './enums';

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface LoginRequest {
  email: string;
  password: string;
  tenantSlug?: string;
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
  fullName: string;
  isSuperAdmin: boolean;
  tenantId: string | null;
  tenantName: string | null;
  role: Role;
  permissions: Permission[];
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: string;
  user: AuthenticatedUser;
}

// ── Tenants (spec §4.2 Super Admin actions) ──────────────────────────────────

export interface TenantSettings {
  staffCanLaunchCampaigns: boolean;
  staffCanTriggerCalls: boolean;
  lowBalanceBehavior: LowBalanceBehavior;
  softLimitPaise: string;
  lowBalanceThresholdPaise: string;
}

export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  plan: string;
  contactEmail: string | null;
  settings: TenantSettings;
  createdAt: string;
  wallet?: WalletSummaryDto;
  contactCount?: number;
}

export interface OnboardTenantRequest {
  name: string;
  slug?: string;
  contactEmail?: string;
  plan?: string;
  managerEmail: string;
  managerFullName: string;
  managerPassword?: string;
  freeCreditsPaise?: string;
  settings?: Partial<TenantSettings>;
}

export interface OnboardTenantResponse {
  tenant: TenantDto;
  manager: { id: string; email: string; temporaryPassword?: string };
  freeCreditsGranted: MoneyDto;
}

// ── Users / staff ─────────────────────────────────────────────────────────────

export interface TenantUserDto {
  id: string;
  userId: string;
  email: string;
  fullName: string;
  role: Role;
  inviteStatus: InviteStatus;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface InviteUserRequest {
  email: string;
  fullName: string;
  role: Extract<Role, 'manager' | 'staff'>;
  password?: string;
}

export interface UpdateStaffRequest {
  fullName: string;
}

export type TeamActivityType = 'campaign_created' | 'template_created' | 'call_triggered';

export interface TeamActivityDto {
  id: string;
  staffUserId: string;
  staffName: string;
  type: TeamActivityType;
  action: string;
  resourceType: 'campaign' | 'template' | 'call';
  resourceId: string;
  resourceName: string;
  status: string;
  occurredAt: string;
}

// ── Contacts (spec §7) ───────────────────────────────────────────────────────

export interface ContactDto {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  customFields: Record<string, unknown>;
  whatsappOptedIn: boolean;
  emailOptedIn: boolean;
  optedOutAt: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateContactRequest {
  fullName: string;
  phone?: string;
  email?: string;
  customFields?: Record<string, unknown>;
  whatsappOptedIn?: boolean;
  emailOptedIn?: boolean;
  tags?: string[];
}

export type UpdateContactRequest = Partial<CreateContactRequest>;

export interface BulkImportContactsRequest {
  csv: string;
  unknownColumnsAsCustomFields?: boolean;
}

export type ContactImportStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface ContactImportDto {
  id: string;
  status: ContactImportStatus;
  totalRows: number;
  processedRows: number;
  successCount: number;
  createdCount: number;
  updatedCount: number;
  failureCount: number;
  errors: Array<{ row: number; message: string }>;
  errorSummary: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** @deprecated imports are asynchronous; use ContactImportDto. */
export type BulkImportContactsResponse = ContactImportDto;

// ── Wallet (spec §8) ─────────────────────────────────────────────────────────

export interface WalletSummaryDto {
  balance: MoneyDto;
  paidBalance: MoneyDto;
  freeCreditBalance: MoneyDto;
  totalRecharged?: MoneyDto;
  totalSpent?: MoneyDto;
  totalFreeCreditsGranted?: MoneyDto;
  rechargeCount?: number;
  lastRechargeAt?: string | null;
  reservedBalance: MoneyDto;
  availableBalance: MoneyDto;
  lowBalance: boolean;
  updatedAt: string;
}

export interface WalletStaffViewDto {
  summary: WalletSummaryDto;
  recentActivity: {
    windowDays: number;
    whatsappMessages: number;
    emails: number;
    aiCallMinutes: number;
    totalSpend: MoneyDto;
  };
}

export interface WalletTransactionDto {
  id: string;
  type: WalletTransactionType;
  bucket: BalanceBucket;
  amount: MoneyDto;
  balanceAfter: MoneyDto;
  description: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}

export interface WalletLedgerDto {
  summary: WalletSummaryDto;
  transactions: WalletTransactionDto[];
  page: PageMeta;
}

// ── Razorpay top-up (spec §8.1) ──────────────────────────────────────────────

export interface CreateTopupRequest {
  amountPaise: string;
  notes?: Record<string, string>;
}

export interface CreateTopupResponse {
  orderId: string;
  razorpayOrderId: string;
  amount: MoneyDto;
  currency: string;
  keyId: string;
  mock: boolean;
  mockCapturePath?: string;
}

// ── Pricing ───────────────────────────────────────────────────────────────────

export interface PricingRuleDto {
  id: string;
  tenantId: string | null;
  eventType: UsageEventType;
  unitPrice: MoneyDto;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
}

// ── Usage ──────────────────────────────────────────────────────────────────────

export interface UsageEventDto {
  id: string;
  eventType: UsageEventType;
  quantity: number;
  unitPrice: MoneyDto;
  totalCharge: MoneyDto;
  idempotencyKey: string;
  contactId: string | null;
  campaignId: string | null;
  callId: string | null;
  occurredAt: string;
}

// ── Templates (spec §6.1) ────────────────────────────────────────────────────

export interface TemplateDto {
  id: string;
  name: string;
  channel: Channel;
  status: TemplateStatus;
  language: string;
  subject: string | null;
  body: string;
  variables: string[];
  providerTemplateName: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export interface CreateTemplateRequest {
  name: string;
  channel: Channel;
  language?: string;
  subject?: string;
  body: string;
}

export interface TemplateAutopilotGenerateRequest {
  channel: Channel;
  prompt: string;
  tone?: string;
  language?: string;
  targetAudience?: string;
}

export interface TemplateAutopilotModifyRequest {
  instruction: string;
}

export interface TemplateAutopilotResult {
  name: string;
  channel: Channel;
  subject: string | null;
  body: string;
  variables: string[];
  category?: string;
  notes?: string;
}

// ── Campaigns (spec §6.1, §6.2) ──────────────────────────────────────────────

export interface CampaignDto {
  id: string;
  name: string;
  channel: Channel;
  status: CampaignStatus;
  templateId: string | null;
  templateName: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  stats: CampaignStatsDto;
  estimatedCost: MoneyDto;
  actualCost: MoneyDto;
  createdBy: string;
  createdAt: string;
}

export interface CampaignStatsDto {
  total: number;
  pending: number;
  sent: number;
  delivered: number;
  opened: number;
  read: number;
  clicked: number;
  failed: number;
  bounced: number;
  skippedOptedOut: number;
  skippedInsufficientFunds: number;
}

export interface CreateCampaignRequest {
  name: string;
  channel: Channel;
  templateId: string;
  contactIds?: string[];
  filter?: { tags?: string[]; all?: boolean };
  scheduledAt?: string;
  variables?: Record<string, string>;
}

export interface CampaignRecipientDto {
  id: string;
  contactId: string;
  contactName: string;
  destination: string;
  status: RecipientStatus;
  providerMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  cost: MoneyDto | null;
}

export interface LaunchCampaignResponse {
  campaignId: string;
  status: CampaignStatus;
  queuedRecipients: number;
  estimatedCost: MoneyDto;
  insufficientFunds?: {
    required: MoneyDto;
    available: MoneyDto;
    shortfall: MoneyDto;
  };
}

// ── AI calling (spec §5) ─────────────────────────────────────────────────────

export interface TranscriptTurnDto {
  sequence: number;
  speaker: TranscriptSpeaker;
  text: string;
  confidence: number | null;
  atSeconds: number;
}

export interface CallDto {
  id: string;
  contactId: string;
  contactName: string;
  direction: CallDirection;
  callType: 'ai' | 'manual';
  bridgeNumber: string | null;
  status: CallStatus;
  outcome: CallOutcome | null;
  providerCallId: string | null;
  fromNumber: string;
  toNumber: string;
  durationSeconds: number;
  billedMinutes: number;
  cost: MoneyDto | null;
  recordingKey: string | null;
  summary: string | null;
  nextAction: string | null;
  priority: 'urgent' | 'high' | 'medium' | 'low' | null;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  salesOutcome: 'interested' | 'not_interested' | 'callback_requested' | 'converted' | null;
  requirement: string | null;
  objection: string | null;
  followUpRequired: boolean | null;
  followUpDate: string | null;
  followUpTime: string | null;
  transcript: TranscriptTurnDto[];
  promptVersion: string | null;
  escalatedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface PlaceCallRequest {
  contactId: string;
  scriptId?: string;
  objective?: string;
  metadata?: Record<string, unknown>;
  callType?: 'ai' | 'manual';
}

/** Manual editing of a call's AI-generated analysis — the "Save Changes" button on the call details modal. */
export interface UpdateCallAnalysisRequest {
  summary?: string;
  nextAction?: string;
  priority?: 'urgent' | 'high' | 'medium' | 'low';
  sentiment?: 'positive' | 'neutral' | 'negative';
  salesOutcome?: 'interested' | 'not_interested' | 'callback_requested' | 'converted';
  requirement?: string;
  objection?: string;
  followUpRequired?: boolean;
  followUpDate?: string;
  followUpTime?: string;
}

// ── 360° timeline (spec §6.4) ────────────────────────────────────────────────

export interface CommunicationEventDto {
  id: string;
  contactId: string;
  channel: Channel;
  eventType: CommunicationEventType;
  direction: EventDirection;
  summary: string;
  campaignId: string | null;
  callId: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface ContactTimelineDto {
  contact: ContactDto;
  events: CommunicationEventDto[];
  page: PageMeta;
}

// ── Reports (spec §11.1) ─────────────────────────────────────────────────────

export interface CampaignReportDto {
  campaigns: Array<{
    campaignId: string;
    name: string;
    channel: Channel;
    sent: number;
    delivered: number;
    opened: number;
    failed: number;
    deliveryRate: number;
    openRate: number;
    cost: MoneyDto;
  }>;
  totals: { sent: number; delivered: number; opened: number; failed: number; cost: MoneyDto };
  trend: Array<{ date: string; sent: number; delivered: number; opened: number }>;
}

export interface CallReportDto {
  totalCalls: number;
  completedCalls: number;
  averageDurationSeconds: number;
  totalBilledMinutes: number;
  cost: MoneyDto;
  outcomeDistribution: Array<{ outcome: CallOutcome; count: number }>;
  followUpsPending: number;
  trend: Array<{ date: string; calls: number; minutes: number }>;
}

export interface UsageReportDto {
  windowStart: string;
  windowEnd: string;
  byChannel: Array<{ channel: Channel; eventType: UsageEventType; quantity: number; spend: MoneyDto }>;
  totalSpend: MoneyDto;
  freeCreditSpend: MoneyDto;
  paidSpend: MoneyDto;
  trend: Array<{ date: string; spend: MoneyDto }>;
}

export interface CrossTenantUsageDto {
  tenants: Array<{
    tenantId: string;
    tenantName: string;
    status: TenantStatus;
    balance: MoneyDto;
    spendThisMonth: MoneyDto;
    whatsappMessages: number;
    emails: number;
    aiCallMinutes: number;
  }>;
  platformTotals: { spend: MoneyDto; tenants: number; activeTenants: number };
}

// ── Shared pagination / errors ───────────────────────────────────────────────

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  items: T[];
  page: PageMeta;
}

export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  path: string;
  timestamp: string;
}

export const ApiErrorCode = {
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  TOPUP_REQUIRED: 'TOPUP_REQUIRED',
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  FORBIDDEN_ROLE: 'FORBIDDEN_ROLE',
  FORBIDDEN_TENANT_POLICY: 'FORBIDDEN_TENANT_POLICY',
  CROSS_TENANT_ACCESS: 'CROSS_TENANT_ACCESS',
  TEMPLATE_NOT_APPROVED: 'TEMPLATE_NOT_APPROVED',
  CONTACT_OPTED_OUT: 'CONTACT_OPTED_OUT',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INTERNAL: 'INTERNAL',
} as const;
export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];