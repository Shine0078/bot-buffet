# Tool contract guide

Every tool has a stable name, JSON input/output schema, scope, risk, reversibility, auth requirement, timeout, rate/output limits, version, owner, and audit behavior. The registry validates both input and redacted output before returning. Tools should return structured evidence and safe error codes; never return raw provider errors or credentials.
