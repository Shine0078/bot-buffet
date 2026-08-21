# Local/offline models

Use a local OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp server, LocalAI, vLLM, or Jan) and create a provider/model through the API. The discovery helper probes common localhost ports. Set `BOT_BUFFET_OFFLINE=true` and use a local model to prevent cloud fallback; routing rejects non-local models before adapter invocation. Keep prompts, files, memory, and traces on the local store for local-only projects.
