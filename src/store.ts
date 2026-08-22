import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AuditEvent, BaseEntity, Entity, ID, ISODate, RuntimeState, now, id } from './types.js';

export const CURRENT_SCHEMA_VERSION = 1;

const emptyState = (): RuntimeState => ({
  entities: {},
  runState: {},
  locks: {},
  idempotency: {},
  auditTail: 'GENESIS',
  schemaVersion: CURRENT_SCHEMA_VERSION,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

/**
 * Normalize a persisted document at the version boundary. Missing fields are
 * legacy defaults; a future schema is rejected instead of being silently
 * interpreted as the current shape.
 */
export function migrateRuntimeState(value: unknown): RuntimeState {
  if (!isRecord(value)) throw new Error('state_schema_invalid');
  const rawVersion = value.schemaVersion === undefined ? 0 : value.schemaVersion;
  if (!Number.isSafeInteger(rawVersion) || (rawVersion as number) < 0)
    throw new Error('state_schema_invalid');
  if ((rawVersion as number) > CURRENT_SCHEMA_VERSION) throw new Error('state_schema_newer');
  const optionalRecord = <T extends Record<string, unknown>>(key: string): T => {
    if (value[key] === undefined) return {} as T;
    if (!isRecord(value[key])) throw new Error('state_schema_invalid');
    return value[key] as T;
  };
  if (value.auditTail !== undefined && typeof value.auditTail !== 'string')
    throw new Error('state_schema_invalid');
  return {
    entities: optionalRecord<RuntimeState['entities']>('entities'),
    runState: optionalRecord<RuntimeState['runState']>('runState'),
    locks: optionalRecord<RuntimeState['locks']>('locks'),
    idempotency: optionalRecord<RuntimeState['idempotency']>('idempotency'),
    auditTail: typeof value.auditTail === 'string' ? value.auditTail : 'GENESIS',
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
}

/** Durable, atomic JSON state for the local/dev profile. The interface is intentionally
 * storage-neutral so production can swap in Postgres/D1 without changing the control plane. */
export class JsonStateStore {
  private state: RuntimeState = emptyState();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private auditQueue: Promise<AuditEvent> = Promise.resolve(undefined as never);
  private mutationQueue: Promise<void> = Promise.resolve();
  private lockQueue: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      this.state = migrateRuntimeState(parsed);
      if (JSON.stringify(parsed) !== JSON.stringify(this.state)) await this.persist();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      await mkdir(dirname(this.filePath), { recursive: true });
      await this.persist();
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const operation = async (): Promise<void> => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      await rename(tmp, this.filePath);
    };
    this.writeQueue = this.writeQueue.then(operation, operation);
    return this.writeQueue;
  }

  async put<T extends BaseEntity>(value: T): Promise<T> {
    const operation = this.mutationQueue.then(async () => {
      await this.load();
      const saved = { ...value, updatedAt: now(), version: value.version + 1 } as T;
      this.state.entities[saved.id] = saved as unknown as Entity;
      await this.persist();
      return saved;
    });
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async putIfVersion<T extends BaseEntity>(value: T, expectedVersion: number): Promise<T> {
    const operation = this.mutationQueue.then(async () => {
      await this.load();
      const current = this.state.entities[value.id] as T | undefined;
      if (!current || current.version !== expectedVersion) throw new Error('concurrent_update');
      const saved = { ...value, updatedAt: now(), version: expectedVersion + 1 } as T;
      this.state.entities[saved.id] = saved as unknown as Entity;
      await this.persist();
      return saved;
    });
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async insert<T extends BaseEntity>(value: T): Promise<T> {
    const operation = this.mutationQueue.then(async () => {
      await this.load();
      if (this.state.entities[value.id]) throw new Error(`entity_exists:${value.id}`);
      this.state.entities[value.id] = value as unknown as Entity;
      await this.persist();
      return value;
    });
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /** Atomically insert or update a record when a portable upsert is required. */
  async upsert<T extends BaseEntity>(value: T): Promise<T> {
    const operation = this.mutationQueue.then(async () => {
      await this.load();
      const current = this.state.entities[value.id] as T | undefined;
      const saved = current
        ? ({
            ...current,
            ...value,
            createdAt: current.createdAt,
            updatedAt: now(),
            version: current.version + 1,
          } as T)
        : value;
      this.state.entities[saved.id] = saved as unknown as Entity;
      await this.persist();
      return saved;
    });
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async get<T extends BaseEntity>(entityId: ID): Promise<T | undefined> {
    await this.load();
    return this.state.entities[entityId] as T | undefined;
  }

  async list<T extends BaseEntity>(predicate?: (value: Entity) => boolean): Promise<T[]> {
    await this.load();
    return Object.values(this.state.entities).filter(
      (value) => !predicate || predicate(value),
    ) as unknown as T[];
  }

  async delete(entityId: ID): Promise<void> {
    const operation = this.mutationQueue.then(async () => {
      await this.load();
      delete this.state.entities[entityId];
      await this.persist();
    });
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  async getRunState(runId: ID): Promise<Record<string, unknown>> {
    await this.load();
    return structuredClone(this.state.runState[runId] ?? {});
  }

  async setRunState(runId: ID, value: Record<string, unknown>): Promise<void> {
    const operation = this.mutationQueue.then(async () => {
      await this.load();
      this.state.runState[runId] = structuredClone(value);
      await this.persist();
    });
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  async getIdempotency(
    key: string,
  ): Promise<{ status: number; payload: unknown; createdAt: string } | undefined> {
    await this.load();
    const record = this.state.idempotency[key];
    if (!record) return undefined;
    if (Date.now() - Date.parse(record.createdAt) > 24 * 60 * 60 * 1000) {
      delete this.state.idempotency[key];
      await this.persist();
      return undefined;
    }
    return structuredClone(record);
  }

  async setIdempotency(key: string, status: number, payload: unknown): Promise<void> {
    const operation = this.mutationQueue.then(async () => {
      await this.load();
      this.state.idempotency[key] = { status, payload: structuredClone(payload), createdAt: now() };
      await this.persist();
    });
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  async claimIdempotency(
    key: string,
  ): Promise<
    | { claimed: true }
    | { claimed: false; record: { status: number; payload: unknown; createdAt: ISODate } }
  > {
    const operation = this.mutationQueue.then(async () => {
      await this.load();
      const current = this.state.idempotency[key];
      if (current && Date.now() - Date.parse(current.createdAt) <= 24 * 60 * 60 * 1000)
        return { claimed: false as const, record: structuredClone(current) };
      this.state.idempotency[key] = {
        status: 102,
        payload: { code: 'idempotency_in_progress' },
        createdAt: now(),
      };
      await this.persist();
      return { claimed: true as const };
    });
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async lock(resource: string, ownerId: ID, ttlMs: number): Promise<boolean> {
    let acquired = false;
    const operation = this.lockQueue.then(async () => {
      await this.load();
      const current = this.state.locks[resource];
      if (current && current.expiresAt > now() && current.ownerId !== ownerId) return;
      this.state.locks[resource] = {
        ownerId,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      };
      acquired = true;
      await this.persist();
    });
    this.lockQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
    return acquired;
  }

  async unlock(resource: string, ownerId: ID): Promise<void> {
    const operation = this.lockQueue.then(async () => {
      await this.load();
      if (this.state.locks[resource]?.ownerId === ownerId) {
        delete this.state.locks[resource];
        await this.persist();
      }
    });
    this.lockQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  async audit(
    input: Omit<AuditEvent, keyof BaseEntity | 'previousHash' | 'hash'> & {
      ownerId: ID;
      scope: string;
    },
  ): Promise<AuditEvent> {
    const operation = this.auditQueue.then(async () => {
      await this.load();
      const previousHash = this.state.auditTail;
      const base = {
        ...input,
        id: id('audit'),
        version: 1,
        createdAt: now(),
        updatedAt: now(),
        accessPolicy: {
          visibility: 'organization' as const,
          roles: { owner: ['*'], admin: ['*'], auditor: ['read'] },
        },
        previousHash,
      };
      const hash = createHash('sha256').update(JSON.stringify(base)).digest('hex');
      const event = { ...base, hash } as AuditEvent;
      this.state.entities[event.id] = event;
      this.state.auditTail = hash;
      await this.persist();
      return event;
    });
    this.auditQueue = operation.then(
      (event) => event,
      () => undefined as never,
    );
    return operation;
  }

  async verifyAuditChain(): Promise<{ valid: boolean; badEventId?: ID }> {
    await this.load();
    const events = Object.values(this.state.entities).filter(
      (x): x is AuditEvent => x.kind === 'audit-event',
    );
    let previous = 'GENESIS';
    for (const event of events) {
      const withoutHash = { ...event };
      delete (withoutHash as Partial<AuditEvent>).hash;
      const expected = createHash('sha256').update(JSON.stringify(withoutHash)).digest('hex');
      if (event.previousHash !== previous || event.hash !== expected)
        return { valid: false, badEventId: event.id };
      previous = event.hash;
    }
    return { valid: true };
  }

  async snapshot(): Promise<RuntimeState> {
    await this.load();
    return structuredClone(this.state);
  }
}

export const createStore = (dataDir = process.env.BOT_BUFFET_DATA_DIR ?? '.data'): JsonStateStore =>
  new JsonStateStore(join(dataDir, 'state.json'));
