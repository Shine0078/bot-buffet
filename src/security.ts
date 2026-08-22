import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { JsonSchema, Permission, Policy, PolicyRule, Risk } from './types.js';

const SECRET_KEY =
  /(api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key|client[_-]?secret)/i;
// Token budgets and usage counters are operational metadata, not credentials. Keep these
// visible in API responses and telemetry while the broader key matcher still protects
// arbitrary access/refresh tokens and provider credentials.
const NON_SECRET_OPERATIONAL_KEYS = new Set([
  'contexttokens',
  'candidatestokencount',
  'completiontokens',
  'estimatedoutputtokens',
  'inputtokens',
  'maxtokens',
  'maxoutputtokens',
  'outputtokens',
  'prompttokens',
  'tokencount',
  'tokenbudget',
  'tokenlimit',
  'tokensin',
  'tokensout',
  'totaltokensin',
  'totaltokensout',
  'totaltokens',
]);
const SECRET_VALUE =
  /(sk-[A-Za-z0-9_-]{12,}|AIza[\w-]{20,}|Bearer\s+[A-Za-z0-9._-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{12,})/g;

export const fingerprint = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);

export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[REDACTED]');
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.replace(/[_-]/g, '').toLowerCase();
      output[key] =
        SECRET_KEY.test(key) && !NON_SECRET_OPERATIONAL_KEYS.has(normalized)
          ? '[REDACTED]'
          : redactSecrets(item);
    }
    return output;
  }
  return value;
}

export function assertWorkspacePath(
  root: string,
  candidate: string,
  allowAbsolute = false,
): string {
  if (candidate.includes('\0')) throw new Error('path_rejected:null_byte');
  if (isAbsolute(candidate) && !allowAbsolute) throw new Error('path_rejected:absolute_path');
  const resolvedRoot = resolve(root);
  const resolved = resolve(root, candidate);
  const rel = relative(resolvedRoot, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('path_rejected:traversal');
  return resolved;
}

export async function assertWorkspaceRealPath(
  root: string,
  candidate: string,
  forWrite = false,
): Promise<string> {
  const lexical = assertWorkspacePath(root, candidate);
  const resolvedRoot = await realpath(root);
  let resolvedTarget: string;
  try {
    resolvedTarget = await realpath(lexical);
  } catch (error) {
    if (!forWrite || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = await realpath(resolve(lexical, '..'));
    const parentRelative = relative(resolvedRoot, parent);
    if (
      parentRelative === '..' ||
      parentRelative.startsWith(`..${sep}`) ||
      isAbsolute(parentRelative)
    )
      throw new Error('path_rejected:symlink_parent');
    return lexical;
  }
  const relativeTarget = relative(resolvedRoot, resolvedTarget);
  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  )
    throw new Error('path_rejected:symlink_escape');
  return lexical;
}

const SHELL_META = /[;&|`$(){}<>\n\r]/;
export function validateCommand(command: string, allowedCommands: string[] = []): void {
  if (!command.trim() || command.length > 4096)
    throw new Error('command_rejected:empty_or_too_long');
  if (SHELL_META.test(command)) throw new Error('command_rejected:shell_metacharacter');
  const executable = command.trim().split(/\s+/)[0] ?? '';
  if (allowedCommands.length && !allowedCommands.includes(executable))
    throw new Error(`command_rejected:not_allowlisted:${executable}`);
  if (
    /(^|\s)(-e|--eval|-p|--print|--require|--loader|--experimental-loader|--inspect|--inspect-brk)(\s|$)/i.test(
      command,
    )
  )
    throw new Error('command_rejected:code_execution_flag');
  if (
    /(^|\s)(-C|--directory|--prefix|--global|install|exec|run-script)(\s|$)/i.test(command) &&
    /(^|\s)(npm|pnpm|npx|git)(\s|$)/i.test(command)
  )
    throw new Error('command_rejected:workspace_escape_flag');
}

export function validateJsonSchema(schema: JsonSchema, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return [`${path}:expected_object`];
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? [])
      if (!(key in record)) errors.push(`${path}.${key}:required`);
    if (schema.properties)
      for (const [key, child] of Object.entries(schema.properties))
        if (key in record) errors.push(...validateJsonSchema(child, record[key], `${path}.${key}`));
    if (schema.additionalProperties === false && schema.properties)
      for (const key of Object.keys(record))
        if (!(key in schema.properties)) errors.push(`${path}.${key}:additional_property`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) errors.push(`${path}:expected_array`);
    else if (schema.items)
      value.forEach((item, index) =>
        errors.push(...validateJsonSchema(schema.items!, item, `${path}[${index}]`)),
      );
  } else if (schema.type === 'string' && typeof value !== 'string')
    errors.push(`${path}:expected_string`);
  else if (schema.type === 'number' && (typeof value !== 'number' || Number.isNaN(value)))
    errors.push(`${path}:expected_number`);
  else if (schema.type === 'boolean' && typeof value !== 'boolean')
    errors.push(`${path}:expected_boolean`);
  if (schema.enum && !schema.enum.includes(String(value))) errors.push(`${path}:invalid_enum`);
  return errors;
}

const rank: Record<Risk, number> = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };
export interface Decision {
  decision: 'allowed' | 'denied' | 'approval-required';
  reason: string;
}
export function decidePolicy(
  risk: Risk,
  scope: string,
  action: string,
  rules: (Policy | PolicyRule)[],
): Decision {
  const flat = rules.flatMap((item) => ('rules' in item ? item.rules : [item]));
  const matches = flat
    .filter(
      (rule) =>
        rule.action === '*' || rule.action === action || action.startsWith(`${rule.action}:`),
    )
    .filter(
      (rule) => !rule.scopes?.length || rule.scopes.includes(scope) || rule.scopes.includes('*'),
    )
    .filter((rule) => !rule.risks?.length || rule.risks.some((r) => rank[r] >= rank[risk]));
  if (matches.some((rule) => rule.effect === 'deny'))
    return { decision: 'denied', reason: 'policy_denied' };
  if (matches.some((rule) => rule.effect === 'approval'))
    return { decision: 'approval-required', reason: 'policy_approval' };
  return {
    decision: 'allowed',
    reason: matches.length ? 'policy_allowed' : 'default_allow_safe_only',
  };
}

export function hasPermission(
  permission: Permission | undefined,
  action: string,
  resource: string,
): boolean {
  if (!permission || permission.effect !== 'allow') return false;
  const actionAllowed = permission.actions.includes('*') || permission.actions.includes(action);
  const resourceAllowed =
    permission.resource === '*' ||
    permission.resource === resource ||
    resource.startsWith(`${permission.resource}:`);
  return actionAllowed && resourceAllowed;
}

export function assertOffline(offline: boolean, local: boolean): void {
  if (offline && !local) throw new Error('offline_mode:cloud_provider_blocked');
}

const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
const privateIpv4 = (host: string): boolean => {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  return (
    parts[0]! === 10 ||
    parts[0]! === 127 ||
    parts[0]! === 0 ||
    (parts[0]! === 169 && parts[1]! === 254) ||
    (parts[0]! === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0]! === 192 && parts[1]! === 168)
  );
};
const privateHost = (host: string): boolean => {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (localHosts.has(normalized) || privateIpv4(normalized)) return true;
  if (isIP(normalized) === 6)
    return (
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    );
  return false;
};

export function assertSafeEndpoint(endpoint: string, allowLocal = false): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('endpoint_rejected:invalid_url');
  }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('endpoint_rejected:unsupported_protocol');
  if (parsed.username || parsed.password) throw new Error('endpoint_rejected:embedded_credentials');
  if (
    parsed.hostname === 'metadata.google.internal' ||
    (!allowLocal && privateHost(parsed.hostname))
  )
    throw new Error('endpoint_rejected:metadata_or_loopback');
  if (allowLocal && !localHosts.has(parsed.hostname.toLowerCase()) && privateHost(parsed.hostname))
    throw new Error('endpoint_rejected:private_network');
  if (!allowLocal && parsed.protocol !== 'https:')
    throw new Error('endpoint_rejected:tls_required');
  return parsed;
}

export async function resolveSafeEndpoint(
  endpoint: string,
  allowLocal = false,
): Promise<{ url: URL; address: string }> {
  const parsed = assertSafeEndpoint(endpoint, allowLocal);
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('endpoint_rejected:dns_lookup_failed');
  }
  if (!addresses.length) throw new Error('endpoint_rejected:dns_no_address');
  for (const address of addresses) {
    if (
      privateHost(address.address) &&
      !(
        allowLocal &&
        localHosts.has(parsed.hostname.toLowerCase()) &&
        (address.address === '127.0.0.1' || address.address === '::1')
      )
    )
      throw new Error('endpoint_rejected:private_or_metadata');
  }
  return { url: parsed, address: addresses[0]!.address };
}

export async function assertSafeEndpointResolved(
  endpoint: string,
  allowLocal = false,
): Promise<URL> {
  return (await resolveSafeEndpoint(endpoint, allowLocal)).url;
}
