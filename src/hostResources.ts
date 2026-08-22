import { cpus, totalmem, freemem, platform as osPlatform, arch as osArch } from 'node:os';
import { volumeSpace } from './modelArtifacts.js';

/**
 * Host resource detection for local model sizing.
 *
 * The specification asks Bot Buffet to detect CPU, GPU, VRAM, RAM, and disk
 * requirements. Four of those are reliably readable from Node on every
 * supported platform. GPU and VRAM are not: there is no cross-platform API,
 * and the alternatives all mean shelling out to a vendor tool that may be
 * absent, stale, or report a device the inference runtime will not use.
 *
 * So GPU is reported as an explicit `unknown` state rather than guessed at.
 * A wrong VRAM figure is worse than no figure — it would let the harness
 * green-light a model the machine cannot load, which is exactly the failure
 * the check exists to prevent. The `detection` field says which values were
 * measured and which were not, so callers can render a pending state instead
 * of a confident wrong one.
 */

export type GpuDetection = 'unknown';

export interface HostResources {
  platform: string;
  arch: string;
  cpu: {
    logicalCores: number;
    model: string | null;
    speedMhz: number | null;
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
  };
  disk: {
    path: string;
    totalBytes: number;
    freeBytes: number;
  } | null;
  gpu: {
    /** Always `unknown`: see the module comment. Never fabricate a VRAM figure. */
    detection: GpuDetection;
    reason: string;
  };
  /** Which fields were measured on this host, for honest UI states. */
  detection: {
    cpu: boolean;
    memory: boolean;
    disk: boolean;
    gpu: boolean;
  };
}

const GPU_REASON =
  'No cross-platform GPU or VRAM API is available from Node. Reporting an unverified figure could green-light a model this machine cannot load, so the value is left undetected rather than guessed.';

export async function detectHostResources(diskPath?: string): Promise<HostResources> {
  const cores = cpus();
  const first = cores[0];

  let disk: HostResources['disk'] = null;
  if (diskPath) {
    try {
      const space = await volumeSpace(diskPath);
      disk = { path: diskPath, totalBytes: space.totalBytes, freeBytes: space.freeBytes };
    } catch {
      // An unreadable path is reported as undetected, not as zero bytes free,
      // which would refuse every import for the wrong reason.
      disk = null;
    }
  }

  return {
    platform: osPlatform(),
    arch: osArch(),
    cpu: {
      logicalCores: cores.length,
      model: first?.model?.trim() || null,
      speedMhz: first?.speed && first.speed > 0 ? first.speed : null,
    },
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    disk,
    gpu: { detection: 'unknown', reason: GPU_REASON },
    detection: {
      cpu: cores.length > 0,
      memory: totalmem() > 0,
      disk: disk !== null,
      gpu: false,
    },
  };
}

export type FitVerdict = 'fits' | 'tight' | 'insufficient' | 'unknown';

export interface ModelFit {
  verdict: FitVerdict;
  reasons: string[];
}

/**
 * Judge whether a model of a given size plausibly fits in RAM.
 *
 * This is advisory and says so. Real memory use depends on quantization,
 * context length, KV cache, and whether the runtime memory-maps the weights,
 * none of which are known here. The verdict is therefore coarse, and the
 * multiplier is deliberately conservative: `tight` warns rather than blocks,
 * and only a model larger than total RAM is called insufficient, because a
 * memory-mapped model can legitimately exceed free RAM.
 */
export function assessModelFit(sizeBytes: number, resources: HostResources): ModelFit {
  const reasons: string[] = [];
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { verdict: 'unknown', reasons: ['model_size_unknown'] };
  }
  if (!resources.detection.memory) {
    return { verdict: 'unknown', reasons: ['host_memory_undetected'] };
  }

  const { totalBytes, freeBytes } = resources.memory;
  if (sizeBytes > totalBytes) {
    reasons.push('model_exceeds_total_memory');
    return { verdict: 'insufficient', reasons };
  }
  if (sizeBytes > freeBytes) {
    // Legitimate for a memory-mapped model, so this warns rather than refuses.
    reasons.push('model_exceeds_free_memory');
    return { verdict: 'tight', reasons };
  }
  if (sizeBytes > freeBytes * 0.8) {
    reasons.push('model_near_free_memory_limit');
    return { verdict: 'tight', reasons };
  }
  return { verdict: 'fits', reasons };
}
