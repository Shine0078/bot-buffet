# Backup and restore

Local state is the `.data/state.json` file; copy it while the service is stopped and protect it like private application data. Production backups must be encrypted, versioned, retention-limited, and tested. Restore to a new project/tenant, verify object and audit hashes, run migrations, verify `/readyz`, execute a golden task and permission tests, then promote by changing traffic—not by overwriting the only copy.
