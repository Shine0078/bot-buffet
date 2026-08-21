# Architecture

Bot Buffet is divided into three logical planes. The control plane exposes scoped entities and policies through the HTTP API. The execution plane is the `Orchestrator`, adapter registry, tool registry, and sandbox context. The data plane is the durable store, checkpoints, artifacts, memory records, usage, and audit chain.

The durable store has a narrow interface (`get`, `list`, `insert`, `put`, locks, run state, audit). The local JSON implementation is atomic and portable; production uses the same contract over a relational database plus object storage. `ModelRouter` is independent from adapters, so a local Ollama/LM Studio/vLLM endpoint and an authenticated cloud provider share the same permission and verification path.

The Office UI consumes `/api/v1/bootstrap` and `/events`; it does not hold credentials or execute tools. All mutating requests carry an actor header in development and must be replaced by verified claims in production.
