# Cloud-Monitor combined backend/frontend review

Audited backend baseline: `af29f690dee45fd9f6b6644b71abdb508ad76be5`  
Reviewed frontend source: `cloud-monitor-frontend(1).zip` supplied on 2026-08-23.

## Frontend fixes included

1. Uses the official per-device stale result first; the compatibility fallback now
   uses `max(staleAfterMs, syncUploadIntervalMs * 2)` rather than `1.5x`.
2. The headline Token mix now respects `capabilities.tokenComponents`; unknown
   provenance is shown as **组成未知**, never invented as non-cached input.
3. `clientHealth.clients` is unwrapped correctly; metadata fields such as
   `version` and `observedAt` cannot become fake client rows.
4. Diagnostic colors use an explicit state enum. `not-running` and `missing`
   render as abnormal instead of being matched by the substring `run`.
5. The device page explains that stale status is server-authoritative rather than
   advertising one misleading global minute threshold.
6. The login gate now has a main landmark and an accessible label; device-card
   headings no longer skip from h1 to h3.
7. View switching preserves query parameters such as `?demo=1`.
8. Long-range activity discloses the hybrid date basis when compacted daily
   anchors are device-local.

## Backend fixes applied by `apply_backend_review_fixes.py`

1. `dashboard_period.today.endsAt` points to the **next** local midnight rather
   than the current day's already-expired start.
2. Activity coverage/gap calculations respect each device's configured upload
   interval. A 30-minute uploader is no longer judged against a 5-minute sample
   cadence.
3. Activity responses disclose when daily data combines dashboard-time-zone fine
   buckets with older device-local daily anchors.
4. All `httpx` transport errors, including read timeouts and protocol failures,
   are mapped to `UpstreamUnavailable` rather than leaking as HTTP 500.
5. Terminal upstream 4xx responses move outbox rows to `rejected`; they are not
   replayed forever.
6. An ingest response missing the normalized device leaves the row pending and
   writes no zero-token snapshot.
7. The maintenance thread is joined before shared HTTP clients and SQLite close.
8. Legacy device re-ingest is marked complete only after every payload succeeds.
9. Provider-status cache keys include `observed_as` aliases, gather exceptions
   produce an explicit unknown row, and total refresh failure preserves the
   last-known-good cache.

## Independent frontend validation performed here

- `node --check tm.js`: pass
- `node --check mock.js`: pass
- Chromium with the production HTML/CSS/JS injected at:
  - 1440×900
  - 768×1024
  - 375×812
  - 320×568
- Four views at every viewport: overview, devices, quota, history
- Result: 20 regression cases, zero runtime error cases, zero page-level
  horizontal overflow.
- Focused assertions passed for:
  - unknown Token provenance in the headline KPI;
  - nested official `clientHealth.clients`;
  - `not-running`/`missing` abnormal state;
  - 30-minute device online at 50 minutes and 5-minute device offline at 20;
  - login landmark and corrected device heading level.

Evidence is in `evidence/review-regression-results.json` and the two screenshots.

## Verification required after applying to the repository

`apply_to_repo.sh` runs the complete backend and agent pytest suites available in
the repository. The Playwright suite requires npm packages and Chromium; GitHub
Actions installs these and runs it through `frontend-tests.yml`.
