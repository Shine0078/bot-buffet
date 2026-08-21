import { Model, ModelRoute, ID } from './types.js';
import { assertOffline } from './security.js';

export interface RoutingRequest {
  category?: string;
  reasoning?: 'low' | 'medium' | 'high';
  coding?: boolean;
  contextTokens: number;
  privacy: 'public' | 'internal' | 'private';
  localPreferred?: boolean;
  offline: boolean;
  estimatedCostCents?: number;
}
export interface RoutingDecision {
  modelId: ID;
  attempted: ID[];
  reason: string;
}

export class ModelRouter {
  constructor(
    private readonly models: () => Promise<Model[]>,
    private readonly health: (modelId: ID) => Promise<boolean> = async () => true,
  ) {}

  async choose(
    request: RoutingRequest,
    route?: ModelRoute,
    overrideModelId?: ID,
  ): Promise<RoutingDecision> {
    const inventory = await this.models();
    const eligible = inventory
      .filter(
        (model) =>
          model.available &&
          model.capabilities.contextTokens !== undefined &&
          model.capabilities.contextTokens >= request.contextTokens,
      )
      .filter((model) => !request.offline || model.local)
      .filter(
        (model) => request.privacy !== 'private' || model.local || request.localPreferred !== true,
      );
    if (overrideModelId) {
      const selected = eligible.find((model) => model.id === overrideModelId);
      if (!selected) throw new Error('routing:override_not_eligible');
      return { modelId: selected.id, attempted: [selected.id], reason: 'manual_override' };
    }
    const candidates = route
      ? [...route.modelIds, ...route.fallbackModelIds]
      : eligible.map((model) => model.id);
    const filtered = candidates
      .map((id) => eligible.find((model) => model.id === id))
      .filter((x): x is Model => Boolean(x));
    if (!filtered.length) throw new Error('routing:no_eligible_models');
    const ordered =
      route?.strategy === 'least-cost'
        ? [...filtered].sort((a, b) => a.inputCostPerMillionCents - b.inputCostPerMillionCents)
        : route?.strategy === 'privacy-first'
          ? [...filtered].sort((a, b) => Number(b.local) - Number(a.local))
          : filtered;
    for (const model of ordered)
      if (await this.health(model.id)) {
        assertOffline(request.offline, model.local);
        return {
          modelId: model.id,
          attempted: ordered.map((x) => x.id),
          reason: route?.strategy ?? (request.localPreferred ? 'local_preferred' : 'health_first'),
        };
      }
    throw new Error('routing:all_providers_unhealthy');
  }
}
