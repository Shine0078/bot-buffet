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
  context: { path?: string; environmentId?: string } = {},
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
    .filter(
      (rule) =>
        !rule.environments?.length ||
        (context.environmentId !== undefined && rule.environments.includes(context.environmentId)),
    )
    .filter((rule) => {
      if (!rule.paths?.length) return true;
      const path = context.path;
      if (!path) return false;
      return rule.paths.some(
        (allowed) =>
          path === allowed ||
          path.startsWith(`${allowed.replace(/\\/g, '/')}/`) ||
          path.startsWith(`${allowed}/`),
      );
    })
    // A rule's risks are a threshold: it applies when the action is at least that risky.
    // Comparing the other way made a "require approval for high risk" rule match safe actions.
    .filter((rule) => !rule.risks?.length || rule.risks.some((r) => rank[risk] >= rank[r]));
  if (matches.some((rule) => rule.effect === 'deny'))
    return { decision: 'denied', reason: 'policy_denied' };
  if (matches.some((rule) => rule.effect === 'approval'))
    return { decision: 'approval-required', reason: 'policy_approval' };
  return {
    decision: 'allowed',
    reason: matches.length ? 'policy_allowed' : 'default_allow_safe_only',
  };
}

/** The context a permission's conditions are matched against. */
export type PermissionContext = Record<string, string | undefined>;

export type PermissionDecision = 'allow' | 'deny' | 'unspecified';

export interface PermissionQuery {
  subjectId: string;
  action: string;
  resource: string;
  context?: PermissionContext;
}

const actionMatches = (permission: Permission, action: string): boolean =>
  permission.actions.includes('*') || permission.actions.includes(action);

/**
 * Resource matching is exact, wildcard, or segment-prefix: a permission on
 * `run` covers `run:abc`, but a permission on `run:abc` covers only that one.
 *
 * The prefix comparison deliberately requires the `:` separator. Without it a
 * permission on `project` would also match a resource named `project-secrets`,
 * which is a different resource that merely starts with the same letters.
 */
const resourceMatches = (permission: Permission, resource: string): boolean =>
  permission.resource === '*' ||
  permission.resource === resource ||
  resource.startsWith(`${permission.resource}:`);

/**
 * Every condition must hold for the permission to apply.
 *
 * This is the half that was missing. `conditions` was declared, accepted, and
 * stored, and the check ignored it -- so a permission written to apply only
 * within one project applied everywhere, and the rule was strictly broader than
 * it read. A condition key absent from the context does not match: an
 * unevaluatable condition must narrow, never widen, or a caller that forgets to
 * pass context silently receives the unconditioned grant.
 */
const conditionsMatch = (permission: Permission, context: PermissionContext): boolean =>
  Object.entries(permission.conditions ?? {}).every(([key, expected]) => context[key] === expected);

const applies = (permission: Permission, query: PermissionQuery): boolean =>
  permission.subjectId === query.subjectId &&
  actionMatches(permission, query.action) &&
  resourceMatches(permission, query.resource) &&
  conditionsMatch(permission, query.context ?? {});

/**
 * Evaluate a set of permissions.
 *
 * Explicit deny wins over allow, following the same rule as every other policy
 * engine here and in the industry generally: a deny is the only way to carve an
 * exception out of a broad grant, and it is worthless if an unrelated allow can
 * cancel it. `unspecified` means no permission addressed the question at all,
 * which the caller resolves against its own default -- it is not the same
 * answer as `deny`, and collapsing the two would make it impossible to tell a
 * deliberate refusal from silence.
 */
export function evaluatePermissions(
  permissions: readonly Permission[],
  query: PermissionQuery,
): PermissionDecision {
  const relevant = permissions.filter((permission) => applies(permission, query));
  if (relevant.some((permission) => permission.effect === 'deny')) return 'deny';
  if (relevant.some((permission) => permission.effect === 'allow')) return 'allow';
  return 'unspecified';
}

/** Single-permission convenience. Conditions are honoured here too. */
export function hasPermission(
  permission: Permission | undefined,
  action: string,
  resource: string,
  context: PermissionContext = {},
): boolean {
  if (!permission) return false;
  return (
    evaluatePermissions([permission], {
      subjectId: permission.subjectId,
      action,
      resource,
      context,
    }) === 'allow'
  );
}

export function assertOffline(offline: boolean, local: boolean): void {
  if (offline && !local) throw new Error('offline_mode:cloud_provider_blocked');
}

const localHosts = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * URL.hostname keeps the brackets on an IPv6 literal ("[::1]"), which matches
 * none of the bare forms above. Both the loopback check and the private-range
 * check must compare against the same normalised value, or an address is
 * classified differently depending on which check looks at it.
 */
const normalizeHost = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, '');
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
  const normalized = normalizeHost(host);
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
  if (allowLocal) {
    // `allowLocal` means "this must be a local runtime", not "relax the rules".
    //
    // The previous form only rejected hostnames that were *private*, so a
    // public host fell through every check: it is not metadata, not private,
    // and the TLS requirement below is skipped for local endpoints. That let a
    // model registered through the offline-only local path point at an
    // arbitrary remote server over plaintext, which would send prompts
    // off-host while the API still reported `offlineOnly: true`.
    //
    // Loopback is the whole meaning of the flag, and it is what local
    // discovery probes, so require exactly that. Private LAN addresses were
    // already rejected and still are.
    if (!localHosts.has(normalizeHost(parsed.hostname)))
      throw new Error('endpoint_rejected:not_loopback');
    return parsed;
  }
  if (parsed.protocol !== 'https:') throw new Error('endpoint_rejected:tls_required');
  return parsed;
}

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string }>>;

export async function resolveSafeEndpoint(
  endpoint: string,
  allowLocal = false,
  lookupFn: DnsLookup = (hostname) => lookup(hostname, { all: true, verbatim: true }),
): Promise<{ url: URL; address: string }> {
  const parsed = assertSafeEndpoint(endpoint, allowLocal);
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookupFn(parsed.hostname);
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
