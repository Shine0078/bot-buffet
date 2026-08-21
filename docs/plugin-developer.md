# Plugin developer guide

Plugins are metadata-first extensions. A plugin is created disabled and must declare its source, version, network policy, retention, and permissions. Enabling, updating, rolling back, or deleting a plugin requires an administrator who is authorized for the workspace. Updates and rollbacks require a 64-character SHA-256 integrity value and can only occur while disabled.

MCP servers use the `/api/v1/mcp-servers` endpoints and support `stdio`, `sse`, and `streamable-http` transport metadata. Non-stdio endpoints must use HTTPS; servers are created disabled and can be enabled or disabled independently. Tool exposure still depends on the agent profile's allowed tool/plugin IDs and the run policy.

The current local implementation does not install or execute arbitrary package code. A production plugin host must add signature verification, dependency/license review, isolated execution, short-lived credentials, egress allowlists, health checks, retention enforcement, and a tested uninstall cleanup path before enabling executable plugins. Treat all plugin content and tool descriptions as untrusted input.
