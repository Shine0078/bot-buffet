import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { JsonSchema, Permission, Policy, PolicyRule, Risk } from './types.js';

const SECRET_KEY =
  /(api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key|client[_-]?secret)/i;
const SECRET_VALUE =
  /(sk-[A-Za-z0-9_-]{12,}|AIza[\w-]{20,}|Bearer\s+[A-Za-z0-9._-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{12,})/g;

export const fingerprint = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);

export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[REDACTED]');
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactSecrets(item);
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

const SHELL_META = /[;&|`$(){}<>\n\r]/;
export function validateCommand(command: string, allowedCommands: string[] = []): void {
  if (!command.trim() || command.length > 4096)
    throw new Error('command_rejected:empty_or_too_long');
  if (SHELL_META.test(command)) throw new Error('command_rejected:shell_metacharacter');
  const executable = command.trim().split(/\s+/)[0] ?? '';
  if (allowedCommands.length && !allowedCommands.includes(executable))
    throw new Error(`command_rejected:not_allowlisted:${executable}`);
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

export function assertSafeEndpoint(endpoint: string): URL {
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
    parsed.hostname === '169.254.169.254' ||
    parsed.hostname === 'metadata.google.internal' ||
    parsed.hostname === '::1'
  )
    throw new Error('endpoint_rejected:metadata_or_loopback');
  return parsed;
}
