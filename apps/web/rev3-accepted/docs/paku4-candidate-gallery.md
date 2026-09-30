# Paku 4 - Candidate gallery, compare, zoom, background, master selection (rev3)

TDD contract test: `smoke-candidate-gallery.mjs` (RED -> GREEN).

## Fixed by this gallery

- Acceptance criterion: "Candidate compare supports zoom/background and
  explicit master selection" was previously absent on rev3 pages.
- The gallery owns ONLY real backend job history from localStorage
  `gandiwa-rev3-create-state-v1` key `jobHistory`. Fabricated previews are
  forbidden (antislop R-17/R-38); an empty history renders an honest empty
  state with a pointer to Create.

## Behavior

- Create page: `#candidate-gallery` grid; each handled job renders a card with
  job id, status text, and stage label; navigating between cards stays local.
- Compare: `#compare-view` compares exactly two candidates, side by side.
- Zoom: `#compare-zoom` range input (50%-240%) scales the compare stage via a
  CSS custom property only; placeholder backgrounds remain honest.
- Background: `#compare-bg-dark` checkbox toggles a dark inspection
  background (dark class `compare-dark`) for artwork-only inspection
  (workspace chrome stays warm-paper per repo rule).
- Master selection: `#master-select` form requires an EXPLICIT choice
  (placeholder option selected by default = no silent default). Submitting
  with the placeholder denied. A chosen candidate binds
  `master = {jobId, artifact, prompt, contentType}` into the same lockMaster
  state contract the Create page already uses, then "Continue to Prepare"
  unlocks. Locking is only possible for a `succeeded` job with an `artifact`
  (owner-scoped backend artifact); every other pick is refused with text.
- Stages covered by stage badges: queued, dispatched, running, waiting
  provider, needs review, failed, cancelled, succeeded. Unknown statuses
  render their raw text (no invented labels).

## Keys (shared with rev3-create.js)

- Read: `get().jobHistory` (array of public job views; includes id, status,
  artifact, artifact_expires_at, queue_position fields when present).
- Write: `master` (identical object shape to Create lockMaster writes), plus
  `masterLockedAt` ISO timestamp. ` Patt`,
  `lastRevisionReason`, `activeJob` never touched.

## Out of scope (deliberate)

- No fabricating images for jobs whose artifact bytes are not local: the
  compare stage shows the honest placeholder text (job id + status) instead
  of pixels. Real bytes flow in once #26 job->canvas wiring lands (slice 3
  pipeline); the compare/selection contracts here are byte-shape-agnostic.
- No routing/fallback; gallery never calls the queue; it only reads browser
  state and (for cancel) delegates to the Create page watcher.
- No batching: one approved prompt = one candidate card = one image.
