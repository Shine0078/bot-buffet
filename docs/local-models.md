# Local/offline models

Use a local OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp server, LocalAI, vLLM, or Jan) and create a provider/model through the API. An authenticated `GET /api/v1/local-models/discover` probes the six loopback candidates and returns each endpoint's reachability and installed model IDs with `offlineOnly: true`; no cloud endpoint is contacted by discovery. The underlying helper probes Ollama (`11434`), LM Studio (`1234`), LocalAI/llama.cpp (`8080`), vLLM (`8000`), and Jan (`1337`) on loopback. Set `BOT_BUFFET_OFFLINE=true` and use a local model to prevent cloud fallback; routing rejects non-local models before adapter invocation. Keep prompts, files, memory, and traces on the local store for local-only projects.

## Importing model weights

A weight file is executable input to an inference runtime, so Bot Buffet treats
it as an untrusted download and decides for itself whether it is acceptable.

Preview first. `POST /api/v1/local-models/import/plan` reports the declared
size, free and total space on the model volume, what would remain afterwards,
the host's measured CPU/memory/disk, and an advisory fit verdict — without
writing anything or transferring a byte. It calls the same decision function
the enforcing route calls, so what the preview shows is what the import will
allow.

Then import. `POST /api/v1/local-models/import` records the artifact against
the model only after the harness has verified it:

| Rule                                                                      | Behaviour                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| No digest supplied                                                        | Refused. There is no bypass and no warning-only path.         |
| Digest not 64 hex characters                                              | Refused before any file is read.                              |
| Size missing, zero, negative, or fractional                               | Refused, so the space check cannot be skipped.                |
| Size + 512 MiB headroom exceeds free space                                | Refused **before** transfer, so a doomed download never runs. |
| Source is `http:` or any non-`https:` scheme                              | Refused. `https:` and local `file:` only.                     |
| Name contains a separator, `..`, a null byte, or is a Windows device name | Refused.                                                      |
| Resolved destination outside the store root                               | Refused, rather than trusting the path join.                  |
| Digest does not match the bytes on disk                                   | Refused at **high** risk; the model records nothing.          |

Verification streams the file through SHA-256, so a multi-gigabyte weight never
has to fit in memory, and compares in constant time. The verified digest, size,
quantization, and license are written to the model by compare-and-swap, so two
concurrent imports cannot leave the metadata describing one artifact while the
digest describes another.

Artifacts live under `BOT_BUFFET_DATA_DIR/models`, beside the durable state
rather than in the repository, so an import works on a read-only container root.

### What is deliberately not claimed

- **GPU and VRAM are not detected.** There is no cross-platform API, and every
  alternative shells out to a vendor tool that may be absent, stale, or naming
  a device the runtime will not use. The API returns an explicit undetected
  state. A wrong VRAM figure would green-light a model the machine cannot load,
  which is the failure the check exists to prevent.
- **The fit verdict is advisory.** Real memory use depends on quantization,
  context length, KV cache, and whether the runtime memory-maps the weights.
  Only a model larger than total RAM is called insufficient, because a
  memory-mapped model may legitimately exceed free RAM.
- **Verification is at import time, not load time.** The digest proves what was
  imported. It does not detect a file replaced afterwards by something with
  write access to the model store. Keep that directory owned by the service
  account and not writable by agents; the sandbox's protected-path rules already
  exclude it from agent-writable roots.
