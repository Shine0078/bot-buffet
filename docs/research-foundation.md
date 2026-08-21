# Research foundation

Retrieved 2026-08-21. These sources were used as design input, not as vendor guarantees.

## Transferable principles

- Microsoft’s harness guide emphasizes a persistent session, planning/todos, context compaction, file memory, and approval flows. Bot Buffet maps those to `Run`/`Checkpoint`, the context assembler, scoped memory, and approval requests. [Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/get-started/harness)
- Firecrawl describes the harness as the non-model layer for tool execution, memory, context, state persistence, recovery, and verification; it also stresses that multiple models should share one harness. Bot Buffet keeps adapters behind `ModelAdapter` and validates/records tool calls before execution. [Firecrawl](https://www.firecrawl.dev/blog/what-is-an-agent-harness)
- Fowler’s article distinguishes computational and inferential sensors. Bot Buffet implements computational checks (schemas, typecheck, tests, policies, audit invariants) and leaves an explicit extension point for independent semantic/security graders. [Martin Fowler](https://martinfowler.com/articles/harness-engineering.html)
- Cloudflare’s harness guidance separates runtime durability from harness behavior and calls out prompt construction, model execution, tool orchestration, persistence, streaming/recovery, and extension hooks. Bot Buffet keeps those concerns in the orchestrator, store, adapters, tools, and SSE API. [Cloudflare Agents](https://developers.cloudflare.com/agents/harnesses/)
- LangChain’s anatomy article treats filesystems, Git, sandboxes, memory/search, context compaction, progressive disclosure, and verification as harness responsibilities. Bot Buffet provides bounded filesystem/shell tools, checkpoints, scoped memory/context compaction, and verification evidence. [LangChain](https://www.langchain.com/blog/the-anatomy-of-an-agent-harness)

## Vendor-specific or inaccessible references

The following prompt references were not treated as verified claims because the exact content was unavailable or the URL did not resolve to a source I could inspect in this run: Databricks AI harness page, PuppyGraph article, Medium “7 components” article, Boringbot Substack, Damian DeMasi project page, Medium “Harness 2.0” article, and the YouTube talk. Owner action if these sources are required for a formal review: provide accessible copies/transcripts or approved network access, then add retrieval dates and claim-level citations here. Optional integrations remain disconnected by design until their owners supply credentials and contract tests.
