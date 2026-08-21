# Local/offline models

Use a local OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp server, LocalAI, vLLM, or Jan) and create a provider/model through the API. The discovery helper probes Ollama (`11434`), LM Studio (`1234`), LocalAI/llama.cpp (`8080`), vLLM (`8000`), and Jan (`1337`) on loopback. Set `BOT_BUFFET_OFFLINE=true` and use a local model to prevent cloud fallback; routing rejects non-local models before adapter invocation. Keep prompts, files, memory, and traces on the local store for local-only projects.
