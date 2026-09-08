# Provider SDK

Planned connector interface for user-selected endpoints and models.

## MVP Connectors

- 9Router through the configured Tailscale/API endpoint;
- fal.ai through its direct API.

Each adapter reports capabilities, validates explicit user selection, returns a redacted provider request ID, and documents idempotency/cancellation behavior. Fake providers are used in CI; live credentials remain backend-local.

This package must not implement cross-provider routing, fallback, load balancing, combo ordering, automatic provider selection, or blind retry of paid generation requests.