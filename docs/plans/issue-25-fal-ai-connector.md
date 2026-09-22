# Issue #25 — fal.ai image-generation connector

Status: local implementation on `feat/issue-25-fal-ai-connector`; live fal.ai
smoke is **not** claimed by this document.

## Scope

This connector is the sole currently registered **image-generation** provider.
9Router remains assistant-only. Gandiwa never routes, falls back, or orders
providers/models.

One approved prompt creates one durable job and requests exactly one image.
Regenerate remains a new creative revision under the Issue #58 contract.

## Pre-dispatch gate

`enqueue_approved_generation()` persists no job unless all of these are true:

- the provider/model pair is explicitly registered (`fal` + selected model);
- deterministic `GENERATION_READY` passes;
- the human approved the exact prompt digest;
- a non-empty rules snapshot, owner session, origin, and idempotency key exist.

The durable job freezes provider, model, prompt, negative prompt, width, height,
`num_images=1`, rules snapshot, approval digest, owner, origin, capability, and
idempotency key. At enqueue, the queue derives a deterministic
`ruleset_snapshot_id` (UUIDv5 over the canonical JSON of the frozen rules
snapshot plus the creation identity, always 36 chars). Two generation jobs with
identical frozen rules share one snapshot ID; any rule/model/provider byte
change forks a new one. Derivation is enqueue-only — preexisting legacy rows
keep NULL, never backfilled at read time. The generation-rules *requirement*
lives here in the #58 dispatch policy; the #21/#23 queue layer derives and
persists the ID but deliberately does not force rules on capability-marker
connector jobs.

## Durable queue / fal queue boundary

1. The worker claims the local job.
2. `mark_dispatched(None)` records the irreversible boundary before remote POST.
3. fal submit returns `request_id`.
4. `QueueStore.record_remote_job_id()` stores it immediately with a lease/status
   CAS; the same ID is idempotent and rebinding to another ID is rejected.
5. Status polling is bounded by a frozen deadline and `max_poll_attempts`.
6. Cancellation before submit performs zero remote I/O. Cancellation after
   submit persists the ID and sends exactly one remote cancel request; any
   uncertain post-boundary outcome is `needs_review` through the #23 bridge.
7. No local credit retry is performed. The request sends `X-Fal-No-Retry: 1`.

## Artifact boundary

Only one image is accepted. The result URL must be HTTPS on the fixed fal media
hosts. Download is streamed with redirects disabled and a hard byte limit.
Downloaded bytes are decoded using the existing PNG/JPEG `inspect_raster`
resource limits; decoded MIME, dimensions, and >=4 MP must match provider
metadata. Only then are bytes staged in the private temporary artifact store.
The final result manifest contains an opaque artifact ID, media type, size,
SHA-256, width, and height — never the remote media URL or local path.

## Secret and network boundary

- `FAL_KEY` is a Pydantic `SecretStr`, excluded from `model_dump()`.
- The key is injected only by the backend transport using fal's official
  `Authorization: Key …` scheme.
- The queue origin is fixed to `https://queue.fal.run` and validated by the SSRF
  policy. HTTP redirects are not followed.
- Provider errors use stable redacted codes; upstream bodies, keys, and private
  artifact bytes are not logged or returned.

## Manual live smoke (post-deploy, optional operational proof)

Do not put the key in Git or shell output. Configure `FAL_KEY` only in the VM's
private environment file, run migrations, start the worker, enqueue one approved
>=4 MP prompt through the application flow, and verify:

- local job reaches `waiting_provider` with a non-empty remote job ID immediately
  after submit;
- poll count stays bounded and the job finishes once;
- one private temporary artifact exists with a valid checksum;
- API/browser payloads contain no key, remote media URL, or local path;
- cancellation of a second test job invokes remote cancel and does not retry.

Record actual date/job IDs separately in operations evidence; this document does
not pre-fill or fabricate a live result.
