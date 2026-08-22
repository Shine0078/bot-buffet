import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { assessModelFit, detectHostResources, type HostResources } from '../src/hostResources.js';

const host = (overrides: Partial<HostResources> = {}): HostResources => ({
  platform: 'linux',
  arch: 'x64',
  cpu: { logicalCores: 8, model: 'Test CPU', speedMhz: 3200 },
  memory: { totalBytes: 32 * 1024 ** 3, freeBytes: 16 * 1024 ** 3 },
  disk: { path: '/srv', totalBytes: 500 * 1024 ** 3, freeBytes: 200 * 1024 ** 3 },
  gpu: { detection: 'unknown', reason: 'test' },
  detection: { cpu: true, memory: true, disk: true, gpu: false },
  ...overrides,
});

describe('host resource detection', () => {
  it('measures CPU, memory, and disk on the real host', async () => {
    const resources = await detectHostResources(tmpdir());
    expect(resources.cpu.logicalCores).toBeGreaterThan(0);
    expect(resources.memory.totalBytes).toBeGreaterThan(0);
    expect(resources.memory.freeBytes).toBeGreaterThanOrEqual(0);
    expect(resources.disk?.totalBytes).toBeGreaterThan(0);
    expect(resources.detection).toMatchObject({ cpu: true, memory: true, disk: true });
  });

  it('reports GPU as undetected rather than inventing a VRAM figure', async () => {
    const resources = await detectHostResources();
    expect(resources.gpu.detection).toBe('unknown');
    expect(resources.detection.gpu).toBe(false);
    // The reason has to explain the refusal, so a UI can show why.
    expect(resources.gpu.reason).toMatch(/cross-platform/i);
  });

  it('reports an unreadable disk path as undetected, not as zero free bytes', async () => {
    const resources = await detectHostResources('/definitely/not/a/real/path/xyzzy');
    expect(resources.disk).toBeNull();
    expect(resources.detection.disk).toBe(false);
    // Zero free bytes would refuse every import for entirely the wrong reason.
  });

  it('omits disk entirely when no path is supplied', async () => {
    const resources = await detectHostResources();
    expect(resources.disk).toBeNull();
    expect(resources.detection.disk).toBe(false);
  });
});

describe('model fit assessment', () => {
  it('passes a model that fits comfortably in free memory', () => {
    expect(assessModelFit(4 * 1024 ** 3, host()).verdict).toBe('fits');
  });

  it('calls a model larger than total memory insufficient', () => {
    const result = assessModelFit(64 * 1024 ** 3, host());
    expect(result.verdict).toBe('insufficient');
    expect(result.reasons).toContain('model_exceeds_total_memory');
  });

  it('warns rather than refuses when a model exceeds free but not total memory', () => {
    // A memory-mapped model legitimately exceeds free RAM, so this must not block.
    const result = assessModelFit(24 * 1024 ** 3, host());
    expect(result.verdict).toBe('tight');
    expect(result.reasons).toContain('model_exceeds_free_memory');
  });

  it('warns when a model approaches the free memory limit', () => {
    const result = assessModelFit(14 * 1024 ** 3, host());
    expect(result.verdict).toBe('tight');
    expect(result.reasons).toContain('model_near_free_memory_limit');
  });

  it('returns unknown rather than guessing when the size is unusable', () => {
    for (const size of [0, -1, Number.NaN]) {
      const result = assessModelFit(size, host());
      expect(result.verdict).toBe('unknown');
      expect(result.reasons).toContain('model_size_unknown');
    }
  });

  it('returns unknown rather than guessing when host memory was not detected', () => {
    const undetected = host({ detection: { cpu: true, memory: false, disk: true, gpu: false } });
    const result = assessModelFit(4 * 1024 ** 3, undetected);
    expect(result.verdict).toBe('unknown');
    expect(result.reasons).toContain('host_memory_undetected');
  });
});
