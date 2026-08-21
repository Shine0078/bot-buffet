# Authentication and credentials

Development uses `x-bot-buffet-user` only for local testing. Production must terminate OIDC/SSO at the edge, validate issuer/audience/nonce, map claims to workspace memberships, and enforce RBAC on every route. API keys/OAuth tokens are write-only inputs to the encrypted `CredentialVault` in local mode (or an external KMS/secret manager in production); the application stores provider, auth type, scopes, expiry, disabled state, and a fingerprint—not values. Rotation is connect-new → test → switch route → revoke-old → audit.
