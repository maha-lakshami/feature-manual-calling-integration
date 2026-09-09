/**
 * Typed API Client for Aiking Logistics Web Portal.
 * Manages in-memory access token and HTTP-only cookie session authentication.
 */
import type {
  CreateTemplateRequest,
  InviteUserRequest,
  Permission,
  TeamActivityDto,
  TenantUserDto,
  TemplateAutopilotGenerateRequest,
  TemplateAutopilotModifyRequest,
  TemplateAutopilotResult,
  TemplateDto,
  UpdateStaffRequest,
} from '@aiking/shared';

export const API_BASE = String((import.meta as any).env?.VITE_API_BASE_URL || '/api').replace(/\/+$/, '');
export const API_DOCS_URL = `${API_BASE}/docs`;

let inMemoryAccessToken: string | null = null;

export function getAccessToken(): string | null {
  return inMemoryAccessToken;
}

export function setAccessToken(token: string | null): void {
  inMemoryAccessToken = token;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}, isRetry = false): Promise<T> {
  const token = inMemoryAccessToken;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers,
  });

  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  // Automatic silent refresh on 401 for non-auth paths
  if (response.status === 401 && !isRetry && !path.startsWith('/auth/')) {
    try {
      const refreshRes = await api.auth.refresh();
      setAccessToken(refreshRes.accessToken);
      return await request<T>(path, options, true);
    } catch {
      setAccessToken(null);
    }
  }

  if (!response.ok) {
    const message = data?.message || data?.error || 'An unexpected error occurred';
    const code = data?.code || 'ERROR';
    throw new ApiError(response.status, code, message, data?.details);
  }

  return data as T;
}

export const api = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  auth: {
    login: async (credentials: { email: string; password: string }) => {
      const res = await request<{
        accessToken: string;
        user: {
          id: string;
          email: string;
          fullName: string;
          role: string;
          tenantId: string | null;
          tenantName: string | null;
          isSuperAdmin: boolean;
          permissions: Permission[];
        };
      }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
      });
      setAccessToken(res.accessToken);
      return res;
    },
    refresh: async () => {
      const res = await request<{
        accessToken: string;
        user: {
          id: string;
          email: string;
          fullName: string;
          role: string;
          tenantId: string | null;
          tenantName: string | null;
          isSuperAdmin: boolean;
          permissions: Permission[];
        };
      }>('/auth/refresh', {
        method: 'POST',
      });
      setAccessToken(res.accessToken);
      return res;
    },
    logout: async () => {
      try {
        await request<any>('/auth/logout', { method: 'POST' });
      } finally {
        setAccessToken(null);
      }
    },
    me: () => request<any>('/auth/me'),
  },

  // ── Tenants (Super Admin) ────────────────────────────────────────────────
  tenants: {
    list: async () => {
      const res = await request<any>('/tenants');
      if (Array.isArray(res)) return { items: res };
      if (res?.items) return res;
      return { items: [] };
    },
    get: (id: string) => request<any>(`/tenants/${id}`),
    current: () => request<any>('/tenants/current'),
    onboard: (data: {
      name: string;
      slug?: string;
      plan?: string;
      managerEmail: string;
      managerFullName: string;
      managerPassword?: string;
      freeCreditsPaise?: string;
    }) =>
      request<any>('/tenants', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    suspend: (id: string, reason?: string) =>
      request<any>(`/tenants/${id}/suspend`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason || 'Administrative suspension' }),
      }),
    resume: (id: string) => request<any>(`/tenants/${id}/resume`, { method: 'POST' }),
  },

  // ── Contacts & CRM ────────────────────────────────────────────────────────
  users: {
    list: () => request<TenantUserDto[]>('/users'),
    activity: () => request<TeamActivityDto[]>('/users/activity'),
    invite: (data: Omit<InviteUserRequest, 'role'> & { role?: 'staff' }) =>
      request<{ member: TenantUserDto; temporaryPassword?: string }>('/users', {
        method: 'POST',
        body: JSON.stringify({ ...data, role: 'staff' }),
      }),
    update: (membershipId: string, data: UpdateStaffRequest) =>
      request<TenantUserDto>(`/users/${membershipId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    setActive: (membershipId: string, active: boolean) =>
      request<TenantUserDto>(`/users/${membershipId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ active }),
      }),
  },

  contacts: {
    list: (params?: { page?: number; pageSize?: number; search?: string; tag?: string }) => {
      const q = new URLSearchParams();
      if (params?.page) q.set('page', params.page.toString());
      if (params?.pageSize) q.set('pageSize', params.pageSize.toString());
      if (params?.search) q.set('search', params.search);
      if (params?.tag) q.set('tag', params.tag);
      return request<{ items: any[]; page: { page: number; pageSize: number; total: number; totalPages: number } }>(
        `/contacts${q.toString() ? `?${q.toString()}` : ''}`,
      );
    },
    get: (id: string) => request<any>(`/contacts/${id}`),
    getTimeline: async (id: string) => {
      const res = await request<any>(`/timeline/contact/${id}`);
      return { timeline: res.events || res.timeline || [] };
    },
    create: (data: {
      fullName: string;
      phone: string;
      email?: string;
      whatsappOptedIn?: boolean;
      emailOptedIn?: boolean;
      tags?: string[];
      customFields?: Record<string, unknown>;
    }) =>
      request<any>('/contacts', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    import: (data: { csv: string; unknownColumnsAsCustomFields?: boolean }) =>
      request<{
        id: string;
        status: 'queued' | 'processing' | 'completed' | 'failed';
        totalRows: number;
        processedRows: number;
        successCount: number;
        createdCount: number;
        updatedCount: number;
        failureCount: number;
        errors: Array<{ row: number; message: string }>;
        errorSummary: string | null;
      }>('/contacts/import', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    importStatus: (id: string) => request<any>(`/contacts/imports/${id}`),
    exportCsv: (params?: { search?: string; tag?: string }) => {
      const q = new URLSearchParams();
      if (params?.search) q.set('search', params.search);
      if (params?.tag) q.set('tag', params.tag);
      return request<string>(`/contacts/export${q.toString() ? `?${q.toString()}` : ''}`);
    },
    tags: () => request<Array<{ tag: string; count: number }>>('/contacts/tags'),
    archive: (id: string) => request<void>(`/contacts/${id}`, { method: 'DELETE' }),
  },

  // ── 360° Timeline ─────────────────────────────────────────────────────────
  timeline: {
    forContact: (contactId: string) =>
      request<{ contact: any; events: any[]; page: any }>(`/timeline/contact/${contactId}`),
  },

  // ── Templates ─────────────────────────────────────────────────────────────
  templates: {
    list: async (params?: { channel?: string; status?: string }) => {
      const query = new URLSearchParams();
      if (params?.channel) query.set('channel', params.channel);
      if (params?.status) query.set('status', params.status);
      const response = await request<TemplateDto[] | { items: TemplateDto[] }>(`/templates${query.size ? `?${query}` : ''}`);
      return Array.isArray(response) ? response : response.items;
    },
    get: (id: string) => request<TemplateDto>(`/templates/${id}`),
    create: (data: CreateTemplateRequest) =>
      request<TemplateDto>('/templates', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<CreateTemplateRequest>) => request<TemplateDto>(`/templates/${id}`, {
      method: 'PATCH', body: JSON.stringify(data),
    }),
    submit: (id: string) => request<TemplateDto>(`/templates/${id}/submit`, { method: 'POST' }),
    pause: (id: string) => request<TemplateDto>(`/templates/${id}/pause`, { method: 'POST' }),
    remove: (id: string) => request<void>(`/templates/${id}`, { method: 'DELETE' }),
    generate: (data: TemplateAutopilotGenerateRequest) => request<TemplateAutopilotResult>('/templates/autopilot/generate', {
      method: 'POST', body: JSON.stringify(data),
    }),
    modify: (id: string, data: TemplateAutopilotModifyRequest) => request<TemplateAutopilotResult>(`/templates/${id}/autopilot/modify`, {
      method: 'POST', body: JSON.stringify(data),
    }),
  },

  // ── Campaigns ─────────────────────────────────────────────────────────────
  campaigns: {
    list: () => request<{ items: any[]; page: any }>('/campaigns'),
    get: (id: string) => request<any>(`/campaigns/${id}`),
    create: (data: {
      name: string;
      channel: string;
      templateId?: string;
      scheduledAt?: string;
      filter?: { tags?: string[]; all?: boolean };
      contactIds?: string[];
      variables?: Record<string, unknown>;
    }) =>
      request<any>('/campaigns', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    launch: (id: string) => request<any>(`/campaigns/${id}/launch`, { method: 'POST' }),
    cancel: (id: string, reason?: string) => request<any>(`/campaigns/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
    remove: (id: string) => request<void>(`/campaigns/${id}`, { method: 'DELETE' }),
  },

  // ── AI Calls & Telephony ──────────────────────────────────────────────────
  calls: {
    list: () => request<{ items: any[]; page: any }>('/calls'),
    get: (id: string) => request<any>(`/calls/${id}`),
    place: async (data: { contactId?: string; toPhone?: string; objective?: string; prompt?: string; scriptId?: string }) => {
      let contactId = data.contactId;
      if (!contactId && data.toPhone) {
        // Find or create contact for the phone number
        const existing = await api.contacts.list({ search: data.toPhone, pageSize: 1 });
        if (existing.items?.length > 0) {
          contactId = existing.items[0].id;
        } else {
          const created = await api.contacts.create({
            fullName: 'Direct Dial Contact',
            phone: data.toPhone,
          });
          contactId = created.id;
        }
      }

      return request<any>('/calls', {
        method: 'POST',
        body: JSON.stringify({
          contactId,
          objective: data.objective || data.prompt || 'Outbound customer confirmation',
          scriptId: data.scriptId,
        }),
      });
    },
  },

  // ── Wallet & Billing ──────────────────────────────────────────────────────
  wallet: {
    get: () =>
      request<{
        summary: any;
        transactions: any[];
      }>('/wallet'),
    getTenantWallet: (tenantId: string) =>
      request<{
        summary: any;
        transactions: any[];
        page?: any;
      }>(`/wallet/tenants/${tenantId}`),
    adjust: (data: { tenantId: string; amountPaise: string; reason: string; allowNegativeBalance?: boolean }) =>
      request<any>('/wallet/adjustments', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    getEffectivePricing: () => request<Record<string, { paise: string; rupees: number; formatted: string }>>('/billing/pricing/effective'),
  },

  // ── Top-ups & Razorpay ────────────────────────────────────────────────────
  topups: {
    create: (amountPaise: string) =>
      request<{
        orderId: string;
        razorpayOrderId: string;
        amount: any;
        currency: string;
        keyId: string;
        mock: boolean;
        mockCapturePath?: string;
      }>('/billing/topups', {
        method: 'POST',
        body: JSON.stringify({ amountPaise }),
      }),
    mockCapture: (orderId: string) =>
      request<{ razorpayPaymentId: string; duplicate: boolean }>(`/billing/topups/${orderId}/mock-capture`, {
        method: 'POST',
      }),
    verify: (orderId: string, data: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) =>
      request<{ status: string; paymentId: string; creditedPaise: string; balanceAfterPaise: string }>(
        `/billing/topups/${orderId}/verify`,
        {
          method: 'POST',
          body: JSON.stringify(data),
        },
      ),
  },
};
