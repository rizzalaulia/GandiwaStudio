# Contracts

Planned versioned schemas shared conceptually across TypeScript and Python.

## MVP Contracts

- portable project manifest and relative asset paths;
- content type, creation method, and four distinct format fields;
- frozen configured-provider/model IDs plus job states including `needs_review`, priority, attempts, remote request ID, lease, heartbeat, cancellation, and result manifest;
- ruleset snapshot and provenance;
- temporary artifact checksum/expiry;
- audit findings, revision-bound approval, export validation, and moderation feedback;
- versioned API request/response/error envelopes.

TypeScript and Python contracts must pass shared conformance fixtures so they cannot drift silently. This package stores no provider secrets and implements no routing behavior.