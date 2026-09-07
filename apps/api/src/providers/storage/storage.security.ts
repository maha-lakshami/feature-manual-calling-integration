import * as path from 'node:path';

import { ProviderError } from '../provider.types';

const TENANT_SEGMENT = /^[A-Za-z0-9_-]+$/;

function invalidKey(operation: string, message: string): never {
  throw new ProviderError('storage', operation, 'invalid_key', message, false);
}

function decodedKeyForms(key: string): string[] {
  const forms = [key];
  let current = key;
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      forms.push(decoded);
      current = decoded;
    } catch {
      break;
    }
  }
  return forms;
}

/** Validate an opaque object key before either a filesystem or HTTP operation. */
export function assertSafeObjectKey(key: string, operation: string): void {
  if (!key || key.includes('\0') || /[\r\n]/.test(key)) invalidKey(operation, 'Object key is invalid');
  if (key.includes('\\')) invalidKey(operation, 'Object keys must use forward-slash separators');

  for (const form of decodedKeyForms(key)) {
    const portable = form.replace(/\\/g, '/');
    if (form.includes('\\')) invalidKey(operation, 'Encoded backslash separators are not allowed');
    if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(form)) {
      invalidKey(operation, 'Absolute object keys are not allowed');
    }
    if (portable.split('/').some((segment) => segment === '.' || segment === '..')) {
      invalidKey(operation, 'Object key traversal is not allowed');
    }
  }
}

/** Require the key to belong to the tenant supplied by the authorized caller. */
export function assertTenantObjectKey(tenantId: string, key: string, operation: string): void {
  if (!TENANT_SEGMENT.test(tenantId)) invalidKey(operation, 'Tenant storage identity is invalid');
  assertSafeObjectKey(key, operation);

  const portable = key.replace(/\\/g, '/');
  const currentPrefix = `tenants/${tenantId}/`;
  // Existing recordings used this layout. It remains readable only by its exact
  // owning tenant while all new objects use the canonical tenants/... namespace.
  const legacyRecordingPrefix = `recordings/${tenantId}/`;
  if (!portable.startsWith(currentPrefix) && !portable.startsWith(legacyRecordingPrefix)) {
    invalidKey(operation, 'Object key is outside the authorized tenant namespace');
  }
}

export function tenantObjectKey(tenantId: string, category: string, objectName: string): string {
  if (!TENANT_SEGMENT.test(tenantId) || !TENANT_SEGMENT.test(category)) {
    invalidKey('key', 'Tenant or object category is invalid');
  }
  const key = `tenants/${tenantId}/${category}/${objectName}`;
  assertTenantObjectKey(tenantId, key, 'key');
  return key;
}

/** AWS SigV4 URI encoding: UTF-8 bytes, uppercase hex, slash preserved. */
export function encodeS3Path(value: string): string {
  let encoded = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e;
    encoded += unreserved || byte === 0x2f ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

export function boundedSignedUrlExpiry(requestedSeconds: number, maximumSeconds: number): number {
  if (!Number.isFinite(requestedSeconds)) return 1;
  return Math.min(maximumSeconds, Math.max(1, Math.floor(requestedSeconds)));
}

/** Canonical containment check with a path-separator boundary. */
export function resolveContainedPath(rootDirectory: string, key: string, operation: string): string {
  assertSafeObjectKey(key, operation);
  const root = path.resolve(rootDirectory);
  const target = path.resolve(root, key.replace(/\\/g, path.sep));
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    invalidKey(operation, 'Object key resolves outside the configured storage root');
  }
  return target;
}
