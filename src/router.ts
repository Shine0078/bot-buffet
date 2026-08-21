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
  estimatedOutputTokens?: number;
  allowedModelIds?: ID[];
  preferredModelId?: ID;
  fallbackModelIds?: ID[];
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
    const estimateCost = (model: Model) =>
      request.estimatedCostCents ??
      (Math.max(0, request.contextTokens) * model.inputCostPerMillionCents +
        Math.max(0, request.estimatedOutputTokens ?? 0) * model.outputCostPerMillionCents) /
        1_000_000;
    const eligible = inventory
      .filter(
        (model) =>
          model.available &&
          model.capabilities.contextTokens !== undefined &&
          model.capabilities.contextTokens >= request.contextTokens,
      )
      .filter((model) => !request.offline || model.local)
      .filter((model) => request.privacy !== 'private' || model.local)
      .filter(
        (model) =>
          !request.allowedModelIds?.length ||
          request.allowedModelIds.includes(model.id) ||
          request.allowedModelIds.includes(model.modelName) ||
          request.allowedModelIds.includes(model.name),
      )
      .filter((model) => !route?.offlineOnly || model.local)
      .filter(
        (model) => route?.maxCostCents === undefined || estimateCost(model) <= route.maxCostCents,
      );
    if (overrideModelId) {
      const selected = eligible.find((model) => model.id === overrideModelId);
      if (!selected) throw new Error('routing:override_not_eligible');
      return { modelId: selected.id, attempted: [selected.id], reason: 'manual_override' };
    }
    const candidates = route
      ? [...route.modelIds, ...route.fallbackModelIds]
      : [
          ...(request.preferredModelId ? [request.preferredModelId] : []),
          ...(request.fallbackModelIds ?? []),
          ...eligible.map((model) => model.id),
        ];
    const filtered = candidates
      .map((id) => eligible.find((model) => model.id === id))
      .filter((x): x is Model => Boolean(x));
    if (!filtered.length) throw new Error('routing:no_eligible_models');
    const ordered =
      route?.strategy === 'least-cost'
        ? [...filtered].sort((a, b) => estimateCost(a) - estimateCost(b))
        : route?.strategy === 'lowest-latency'
          ? [...filtered].sort(
              (a, b) =>
                (a.latencyMs ?? Number.POSITIVE_INFINITY) -
                (b.latencyMs ?? Number.POSITIVE_INFINITY),
            )
          : route?.strategy === 'weighted'
            ? [...filtered].sort((a, b) => (b.routingWeight ?? 0) - (a.routingWeight ?? 0))
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
