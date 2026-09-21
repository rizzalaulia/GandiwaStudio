# Issue #24 — 9Router named-instance connector, Slice A

Status: local implementation slice; **not a completion claim for Issue #24**.

## Purpose

Issue #24 implements a backend-configured 9Router assistant connector. This
Slice A establishes its offline, fail-closed contract before configuration,
registry wiring, browser selection, or a live Tailnet smoke test exist.

9Router is an assistant provider only in the Stage 5 product contract. It
supports `brainstorm`, `finalize_prompt`, `analyze_image`, and
`suggest_metadata`; it is not an image-generation connector.

## Named instances: two 9Router deployments

A deployment may configure two named instances, for example `studio-a` and
`studio-b`. The selected instance ID and its configured `/v1` origin are both
frozen in the durable job identity:

```text
job.provider_id = selected instance ID     # e.g. studio-a
job.origin      = configured instance URL  # exact /v1 origin for studio-a
job.model_id    = model/combo selected by the human
```

`NineRouterClient` rejects a dispatch when either `provider_id` or `origin`
does not exactly match its own named instance. It never probes, reroutes, or
falls back to the other 9Router instance. The upstream model/combo list is
returned in the exact received order, including duplicates; Gandiwa does not
rank, remove, or order combos.

## Slice A artefacts

- `gandiwa_api.connectors.ninerouter.NineRouterClient`
  - `ProviderConnector`-shaped assistant connector with the four bounded
    capabilities above.
  - `models()` requests only `/models` via an injected transport and validates
    the `{"data": [{"id": "..."}]}` shape fail-closed.
  - The constructor validates the configured origin with
    `security.ssrf.validate_9router_base_url` (Tailnet + `/v1` only).
  - `dispatch()` constructs a non-streaming OpenAI-compatible chat request,
    binds selected model/instance/origin, obeys the frozen timeout deadline,
    observes cooperative cancellation before remote I/O (including the race after
    bridge preflight: a durable cancel request transitions the job to `cancelled`,
    not a connector failure), calls the durable `mark_dispatched` boundary
    immediately before transport I/O, propagates the frozen idempotency key as a
    stable `Idempotency-Key` header, validates that the upstream response model
    exactly equals the human-selected model (never overwritten), and validates
    the assistant JSON through `creative.assistant_adapter`.
  - Lease safety: a blocking request outliving the worker lease window cannot
    silently succeed. The client heartbeats before and after remote I/O and runs
    `_LeaseRenewalThread`, a small bounded renewal thread (join on stop, daemon)
    that renews the durable lease during the call; a mid-call lease loss maps to
    `PROVIDER_TIMEOUT`, and a success arriving after the queue CAS considers the
    lease stale maps to `needs_review`, never success.
  - All invalid identity, request, response, transport, auth, quota, timeout,
    and provider failures reduce to stable connector codes; raw response or
    credential text is not surfaced; `QueueError` from the queue is never
    swallowed into connector failure codes.
- `apps/api/tests/test_ninerouter.py`
  - Offline fake transport only; no credential, DNS, Tailnet, or external
    network use.
  - Covers model-list validation/order preservation, all four assistant
    operations, selected-instance/origin mismatch refusal, cancellation and
    deadline preflight, malformed upstream response redaction, normalized
    transport failure codes, malformed local request refusal before any
    transport call, pre/post-call lease renewal, mid-call renewal-thread lease
    safety, stale-lease success refusal, and the atomic
    `finalize_success(remote_job_id=...)` contract.

## Deliberately deferred

These remain required for Issue #24 and are **not implemented by Slice A**:

1. Backend secret configuration for multiple named 9Router instances (the slice
   A contract already validates every constructed origin URL with
   `validate_9router_base_url`).
2. Production `httpx` transport and registry construction from that
   configuration; the injected transport here intentionally makes offline TDD
   possible without retaining credentials in the connector object.
3. UI/API presentation through which a human selects an instance and confirms
   its model/combo before a durable job is created.
4. A manually executable container-to-Tailnet smoke test, documented without
   putting endpoint keys or private assets in the repository.

Those follow as Slice B/C. Until then this connector is not registered for a
production job, and no live 9Router endpoint is contacted.
