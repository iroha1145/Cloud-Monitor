# Post-audit fixes (2026-08-23)

This overlay fixes issues found after the `af29f690` backend and the redesigned
frontend were reviewed together:

- dashboard `today.endsAt` now points to the next local midnight;
- activity coverage respects each device's configured upload interval;
- long-range activity explicitly reports its hybrid day basis after fine buckets
  are compacted into device-local daily anchors;
- terminal upstream 4xx responses leave the outbox instead of replaying forever;
- missing normalized devices never create zero-token snapshots;
- all `httpx` transport failures are mapped to `UpstreamUnavailable`;
- the maintenance thread is joined before HTTP clients and SQLite are closed;
- legacy re-ingest is marked complete only after every payload succeeds;
- provider-status cache keys include aliases and total refresh failure preserves
  the last-known-good status.

The frontend overlay also fixes official per-device stale thresholds, Token
component provenance, nested `clientHealth.clients`, explicit diagnostic enums,
and two moderate accessibility findings.
