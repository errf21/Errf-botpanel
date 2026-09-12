/**
 * Provisioning policy: a versioned JSON document in the `settings` table
 * (seeded by 0005). Same degrade-safe contract as catalog/payment docs —
 * a malformed document never crashes an update and never invents defaults;
 * the caller treats it as "provisioning is not available right now".
 */

export const PROVISIONING_SCHEMA = 1;

export interface ProvisioningConfig {
  enabled: boolean;
  groupIds: number[];
  usernamePrefix: string;
  maxAttempts: number;
  defaultStatus: 'active' | 'on_hold';
}

export type ProvisioningResult =
  | { ok: true; config: ProvisioningConfig }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function parseProvisioningConfig(doc: unknown): ProvisioningResult {
  const record = asRecord(doc);
  if (!record || record['schema'] !== PROVISIONING_SCHEMA) {
    return { ok: false, error: 'provisioning:schema' };
  }
  if (typeof record['enabled'] !== 'boolean') {
    return { ok: false, error: 'provisioning:enabled' };
  }
  const rawGroups = record['group_ids'];
  if (!Array.isArray(rawGroups) || rawGroups.length === 0 || rawGroups.length > 50) {
    return { ok: false, error: 'provisioning:group_ids' };
  }
  const groupIds: number[] = [];
  for (const item of rawGroups) {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1 || item > 1_000_000) {
      return { ok: false, error: 'provisioning:group_ids' };
    }
    groupIds.push(item);
  }
  const prefix = record['username_prefix'];
  // prefix + 28-char order id must fit the 32-char panel username cap.
  if (typeof prefix !== 'string' || !/^[a-z0-9]{1,4}$/.test(prefix)) {
    return { ok: false, error: 'provisioning:username_prefix' };
  }
  const maxAttempts = record['max_attempts'];
  if (
    typeof maxAttempts !== 'number' ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 10
  ) {
    return { ok: false, error: 'provisioning:max_attempts' };
  }
  const defaultStatus = record['default_status'];
  if (defaultStatus !== 'active' && defaultStatus !== 'on_hold') {
    return { ok: false, error: 'provisioning:default_status' };
  }
  return {
    ok: true,
    config: {
      enabled: record['enabled'],
      groupIds,
      usernamePrefix: prefix,
      maxAttempts,
      defaultStatus,
    },
  };
}

export async function loadProvisioningConfig(db: D1Database): Promise<ProvisioningResult> {
  let raw: string | undefined;
  try {
    const row = await db
      .prepare(`SELECT value FROM settings WHERE key = 'provisioning'`)
      .bind()
      .first<{ value: string }>();
    raw = row?.value;
  } catch {
    return { ok: false, error: 'provisioning:unavailable' };
  }
  if (raw === undefined) return { ok: false, error: 'provisioning:missing' };
  try {
    return parseProvisioningConfig(JSON.parse(raw));
  } catch {
    return { ok: false, error: 'provisioning:json' };
  }
}
