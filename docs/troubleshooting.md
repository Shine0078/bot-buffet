# Troubleshooting

If the UI cannot load, check `/healthz`, verify `PORT`, and inspect the redacted process log. If routing reports no eligible model, add an available model with sufficient context or disable offline mode only after policy review. If an approval is pending, resolve it through the Approvals panel/API; expired requests must be recreated. If state is corrupt, stop the process and restore the last verified backup.
