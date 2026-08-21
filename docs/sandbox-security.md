# Sandbox security guide

Each run receives a project-root workspace and an allowlist/protected-path policy from its agent profile. Filesystem tools reject null bytes, absolute paths, traversal, protected writes, oversized writes, and output over the contract limit. Shell execution rejects shell metacharacters, only permits selected executables, enforces a 30-second timeout and 1 MB output cap, and blocks network-shaped commands when the environment network is blocked.

For production, execute tools in a disposable container/Cloudflare Sandbox or equivalent microVM with CPU/RAM/process/disk quotas, egress allowlists, read-only base image, injected short-lived credentials, artifact scanning, and snapshot rollback. Never treat a local model as trusted merely because it is local.
