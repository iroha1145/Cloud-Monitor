import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  availableUpdateTargets,
  isAuthError,
  isMissingArchive,
  makeArchiveFallback,
  mergeArchiveDays,
  nextArchiveCursor,
  normalizeArchivePage,
  normalizeUpdateStatus,
  readArchive,
  readUpdateStatus,
  RestorationHttpError,
  safeGithubUrl,
  submitSystemUpdate,
  validArchiveDay,
  validUpdateRef,
} from "../src/restoration-api";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../tests/fixtures/frontend-contract/history_daily.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const updateFixture = (extra: Record<string, unknown> = {}) => ({
  current: { version: "v1.0.0", git_sha: "1234567abcdef" },
  repo: "https://github.com/example/cloud-monitor",
  latest_release: {
    tag: "v1.1.0",
    name: "Version 1.1",
    html_url: "https://github.com/example/cloud-monitor/releases/tag/v1.1.0",
    published_at: "2026-09-05T03:00:00Z",
    prerelease: false,
    notes: "Release notes",
  },
  main: { sha: "abcdef1234567", short_sha: "abcdef1", message: "Update" },
  release_ahead: true,
  main_ahead: true,
  update_available: true,
  github_error: "",
  checked_at: "2026-09-05T03:00:00Z",
  apply_enabled: true,
  job: { state: "idle", message: "" },
  ...extra,
});

test("archive follows the backend contract and keeps absent coverage unknown", () => {
  const page = normalizeArchivePage(fixture);
  assert.equal(page.items[0].tokens, 1846320);
  assert.equal(page.items[0].costUsd, 4.82);
  assert.equal(page.items[0].coverage, null);
  assert.equal(page.items[0].complete, true);
  assert.deepEqual(page.items[0].perClient, { claude: 1200000, codex: 646320 });
  assert.equal(page.retentionDays, 370);
  assert.equal(page.dayBasis, "device-local");
  assert.equal(page.dashboardTimeZone, "Asia/Tokyo");
});

test("missing and malformed amounts never become zero or a complete archive", () => {
  const page = normalizeArchivePage({
    items: [
      {
        day: "2026-09-01",
        tokens: null,
        costUsd: "",
        perClient: { absent: null, bad: -1, known: 0 },
        coverage: 120,
      },
      {
        day: "2026-09-02",
        tokens: 0,
        costUsd: 0,
        complete: false,
        coverage: 32.8,
      },
      { day: "2026-02-30", tokens: 99, costUsd: 1 },
    ],
  });
  assert.equal(page.items.length, 2);
  assert.equal(page.items[1].tokens, null);
  assert.equal(page.items[1].costUsd, null);
  assert.equal(page.items[1].complete, null);
  assert.equal(page.items[1].coverage, null);
  assert.deepEqual(page.items[1].perClient, { known: 0 });
  assert.equal(page.items[0].tokens, 0);
  assert.equal(page.items[0].costUsd, 0);
  assert.equal(page.items[0].complete, false);
  assert.equal(page.items[0].coverage, 32.8);
  assert.throws(() => normalizeArchivePage({ status: "broken" }), /格式不完整/);
  assert.equal(validArchiveDay("2026-02-30"), false);
  assert.equal(validArchiveDay("2024-02-29"), true);
});

test("negative monetary adjustments remain visible while token counts cannot be negative", () => {
  const page = normalizeArchivePage({
    items: [{ day: "2026-09-01", costUsd: -0.45, tokens: -1 }],
  });
  assert.equal(page.items[0].costUsd, -0.45);
  assert.equal(page.items[0].tokens, null);
  const fallback = makeArchiveFallback({
    timeZone: "UTC",
    activity: [],
    trend: [
      {
        day: "2026-09-01",
        totalTokens: 1,
        costUsd: -0.6,
        models: {},
        components: null,
      },
    ],
  });
  assert.equal(fallback[0].costUsd, -0.6);
});

test("pagination can retain all 370 days and terminates on missing or repeated cursors", () => {
  let rows: ReturnType<typeof normalizeArchivePage>["items"] = [];
  let cursor: string | null = null;
  for (let offset = 0; offset < 370; offset += 30) {
    const days = Array.from({ length: Math.min(30, 370 - offset) }, (_, i) => {
      const day = new Date(Date.UTC(2026, 8, 5) - (offset + i) * 86400000)
        .toISOString()
        .slice(0, 10);
      return { day, tokens: i, costUsd: null };
    });
    const page = normalizeArchivePage({
      items: days,
      has_more: offset + 30 < 370,
      next_cursor: days.at(-1)?.day,
    });
    const merged = mergeArchiveDays(rows, page.items);
    cursor = nextArchiveCursor(page, cursor, merged.length - rows.length);
    rows = merged;
  }
  assert.equal(rows.length, 370);
  assert.equal(cursor, null);
  const repeated = normalizeArchivePage({
    items: [fixture.items[0]],
    has_more: true,
    next_cursor: "2026-08-25",
  });
  assert.equal(nextArchiveCursor(repeated, "2026-08-25", 1), null);
  assert.equal(nextArchiveCursor(repeated, null, 0), null);
  assert.equal(
    nextArchiveCursor({ ...repeated, nextCursor: null }, null, 1),
    null,
  );
  assert.equal(mergeArchiveDays(rows, rows).length, 370);
});

test("fallback uses existing overview days and never invents costs or composition", () => {
  const rows = makeArchiveFallback({
    timeZone: "Asia/Tokyo",
    activity: [
      { day: "2026-09-02", totalTokens: 250 },
      { day: "2026-09-01", totalTokens: 300 },
    ],
    trend: [
      {
        day: "2026-09-02",
        totalTokens: 200,
        costUsd: 0.6,
        models: { model: 200 },
        components: null,
      },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tokens, 250);
  assert.equal(rows[0].costUsd, 0.6);
  assert.equal(rows[1].costUsd, null);
  assert.equal(rows[1].complete, null);
  assert.deepEqual(rows[1].perClient, {});
  assert.deepEqual(rows[0].perModel, { model: 200 });
});

test("archive request sends token and opaque day cursor; only 404/501 qualify for fallback", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url, init) => {
    assert.equal(
      String(url),
      "/api/v1/tm/history/daily?limit=30&cursor=2026-08-25",
    );
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer test-only-key",
    );
    assert.equal(init?.method, "GET");
    return new Response(JSON.stringify(fixture), { status: 200 });
  };
  await readArchive("test-only-key", "2026-08-25");
  assert.equal(
    isMissingArchive(new RestorationHttpError(404, "missing")),
    true,
  );
  assert.equal(
    isMissingArchive(new RestorationHttpError(501, "missing")),
    true,
  );
  assert.equal(
    isMissingArchive(new RestorationHttpError(500, "broken")),
    false,
  );
  assert.equal(
    isMissingArchive(new RestorationHttpError(401, "unauthorized")),
    false,
  );
  assert.equal(
    isAuthError(new RestorationHttpError(401, "unauthorized")),
    true,
  );
  assert.equal(isAuthError(new RestorationHttpError(403, "forbidden")), true);
});

test("update buttons use exact allowed server targets and obey job/apply state", () => {
  assert.deepEqual(
    availableUpdateTargets(normalizeUpdateStatus(updateFixture())).map(
      (target) => target.ref,
    ),
    ["v1.1.0", "main"],
  );
  for (const job of [
    { state: "queued" },
    { state: "running" },
    { state: "unrecognized" },
    {},
  ])
    assert.deepEqual(
      availableUpdateTargets(normalizeUpdateStatus(updateFixture({ job }))),
      [],
    );
  assert.deepEqual(
    availableUpdateTargets(
      normalizeUpdateStatus(updateFixture({ apply_enabled: false })),
    ),
    [],
  );
  assert.deepEqual(
    availableUpdateTargets(
      normalizeUpdateStatus(
        updateFixture({ latest_release: { tag: "../bad" }, main: null }),
      ),
    ),
    [],
  );
  assert.deepEqual(
    availableUpdateTargets(
      normalizeUpdateStatus(
        updateFixture({ release_ahead: false, main_ahead: false }),
      ),
    ),
    [],
  );
  for (const ref of ["main", "master", "v1.2.3", "2.0.0-rc.1"])
    assert.equal(validUpdateRef(ref), true);
  for (const ref of [
    "",
    "feature/x",
    "v1..2",
    "$(whoami)",
    "v" + "1".repeat(70),
  ])
    assert.equal(validUpdateRef(ref), false);
});

test("system check is read-only, explicit apply posts only ref, and errors preserve HTTP status", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls: {
    url: string;
    method: string;
    body: BodyInit | null | undefined;
  }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method || "GET",
      body: init?.body,
    });
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer test-only-key",
    );
    return new Response(
      JSON.stringify(
        init?.method === "POST"
          ? { state: "queued", ref: "v1.1.0", message: "等待宿主机监视器" }
          : updateFixture(),
      ),
      { status: 200 },
    );
  };
  await readUpdateStatus("test-only-key", true);
  assert.deepEqual(calls, [
    { url: "/api/v1/system/update?refresh=1", method: "GET", body: undefined },
  ]);
  const job = await submitSystemUpdate("test-only-key", "v1.1.0");
  assert.equal(job.state, "queued");
  assert.equal(calls[1].body, JSON.stringify({ ref: "v1.1.0" }));
  assert.equal(calls[1].method, "POST");
  await assert.rejects(
    submitSystemUpdate("test-only-key", "bad/ref"),
    /版本标识不受支持/,
  );
  assert.equal(calls.length, 2);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ detail: "已有更新在进行" }), { status: 409 });
  await assert.rejects(
    submitSystemUpdate("test-only-key", "main"),
    (error: unknown) =>
      error instanceof RestorationHttpError &&
      error.status === 409 &&
      error.message === "已有更新在进行",
  );
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "未启用在线更新：未挂载更新目录" }), {
      status: 503,
    });
  await assert.rejects(
    submitSystemUpdate("test-only-key", "main"),
    (error: unknown) =>
      error instanceof RestorationHttpError &&
      error.status === 503 &&
      error.message === "未启用在线更新：未挂载更新目录",
  );
});

test("release links accept only credential-free GitHub HTTPS URLs", () => {
  assert.equal(
    safeGithubUrl("https://github.com/example/repo/releases/tag/v1"),
    "https://github.com/example/repo/releases/tag/v1",
  );
  for (const url of [
    "javascript:alert(1)",
    "https://evil.test/a",
    "http://github.com/a",
    "https://user:secret@github.com/a",
  ])
    assert.equal(safeGithubUrl(url), "");
});
