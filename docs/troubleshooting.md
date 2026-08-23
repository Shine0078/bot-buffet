# Troubleshooting

If the UI cannot load, check `/healthz`, verify `PORT`, and inspect the redacted process log. If routing reports no eligible model, add an available model with sufficient context or disable offline mode only after policy review. If an approval is pending, resolve it through the Approvals panel/API; expired requests must be recreated. If state is corrupt, stop the process and restore the last verified backup.

## Office UI looks empty or buttons do nothing

The Office UI is not a standalone HTML file. It has to be served by the Bot Buffet control plane.

1. From `C:\\Users\\samue\\Documents\\GitHub\\Bot Buffet`, run `npm run dev`.
2. Open http://127.0.0.1:8787.

Do **not** open `ui/index.html` from Explorer or as `file://`. That path has no origin, so `/api/v1/bootstrap` never runs and every button looks dead. A leftover Downloads tree is not this product.

A `file://` open now shows a blocking banner and disables the controls instead of failing silently.
