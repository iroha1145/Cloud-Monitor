"""Daily cache details survive both history fallback and snapshot API assembly."""
import copy
import json
import subprocess

import pytest

from conftest import HUB_ROOT, READ_KEY, TM_SECRET, requires_node, widget_style_payload
from hub.tm_overview import merge_trend_with_history


DETAILS = {
    "outputTokens": 10,
    "cacheReadTokens": 80,
    "cacheWriteTokens": 5,
    "unclassifiedTokens": 0,
    "tokenComponentsAvailable": True,
}


@pytest.mark.parametrize("with_models", [False, True])
def test_official_history_fills_missing_days_with_their_own_cache_and_cost(with_models):
    history = {"daily": [
        {"date": "2026-09-02", "tokens": 100, "cost": 1.25,
         "perModel": {"model": {"tokens": 100}}, **DETAILS},
        {"date": "2026-09-03", "tokens": 0, "cost": 0,
         "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0,
         "unclassifiedTokens": 0, "tokenComponentsAvailable": True},
    ]}
    original = copy.deepcopy(history)
    rows = merge_trend_with_history([], history, with_models=with_models)
    assert rows[0]["total"] == 100
    assert rows[0]["cacheReadTokens"] / rows[0]["total"] == 0.8
    assert rows[0]["costUsd"] == 1.25
    assert rows[1]["cacheReadTokens"] == rows[1]["costUsd"] == 0
    assert ("models" in rows[0]) is with_models
    assert history == original


@pytest.mark.parametrize("with_models", [False, True])
def test_snapshot_wins_entire_day_without_borrowing_official_components(with_models):
    history = {"daily": [{"date": "2026-09-02", "tokens": 100,
                          "cost": 2, **DETAILS}]}
    # A snapshot may cover a different set of devices even on the same date.
    rows = merge_trend_with_history(
        [{"day": "2026-09-02", "total": 40, "costUsd": 0}],
        history, with_models=with_models,
    )
    assert rows[0]["total"] == 40
    assert rows[0]["costUsd"] == 0
    assert "cacheReadTokens" not in rows[0]
    assert "tokenComponentsAvailable" not in rows[0]
    rows = merge_trend_with_history(
        [{"day": "2026-09-02", "total": 100, "costUsd": -0.5, **DETAILS}],
        history, with_models=with_models,
    )
    assert rows[0]["cacheReadTokens"] == 80
    assert rows[0]["costUsd"] == -0.5


def test_unknown_components_remain_unknown_and_partial_counts_remain_partial():
    unknown = {"day": "2026-09-02", "total": 100,
               "cacheReadTokens": None, "cacheWriteTokens": None,
               "outputTokens": None, "unclassifiedTokens": 100,
               "tokenComponentsAvailable": False, "componentsPartial": True}
    partial = {"day": "2026-09-03", "total": 200,
               "cacheReadTokens": 80, "cacheWriteTokens": 5,
               "outputTokens": 10, "unclassifiedTokens": 100,
               "tokenComponentsAvailable": False, "componentsPartial": True}
    assert merge_trend_with_history([unknown, partial], None) == [unknown, partial]
    assert merge_trend_with_history([], {"daily": [{"date": "2026-09-01", "tokens": 7}]}) == [
        {"day": "2026-09-01", "total": 7}
    ]


@requires_node
@pytest.mark.parametrize("with_models", [False, True])
def test_official_aggregate_default_zeros_remain_unknown_in_history_fallback(with_models):
    # Exercise the real /api/history producer: its daily merge turns missing
    # counters into 0 before the Python fallback sees the response.
    result = subprocess.run(
        ["node", "-e", """
const { aggregateHistory } = require('./tm-core/vendor/src/shared/usage.js');
const history = aggregateHistory([{deviceId: 'legacy-history', history: {
  daily: [{date: '2026-09-05', tokens: 100}], monthly: [], summary: {}
}}], {todayKey: '2026-09-05'});
process.stdout.write(JSON.stringify(history));
"""],
        cwd=HUB_ROOT, capture_output=True, text=True, timeout=30, check=True,
    )
    history = json.loads(result.stdout)
    assert history["daily"][0]["cacheReadTokens"] == 0
    assert history["daily"][0]["tokenComponentsAvailable"] is False
    row = merge_trend_with_history([], history, with_models=with_models)[0]
    assert row["total"] == row["unclassifiedTokens"] == 100
    assert row["cacheReadTokens"] is None
    assert row["cacheWriteTokens"] is None
    assert row["outputTokens"] is None
    assert row["componentsPartial"] is True


@pytest.mark.parametrize("available", [True, False, None])
def test_history_zero_counters_require_explicit_availability_but_positive_counts_survive(available):
    entry = {
        "date": "2026-09-05", "tokens": 100, "cost": 1.25,
        "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0,
        "unclassifiedTokens": 0 if available else 100,
    }
    if available is not None:
        entry["tokenComponentsAvailable"] = available
    row = merge_trend_with_history([], {"daily": [entry]})[0]
    assert row["cacheReadTokens"] == (0 if available else None)
    assert row["outputTokens"] == (0 if available else None)
    assert row["cacheWriteTokens"] == (0 if available else None)
    assert row["costUsd"] == 1.25
    if not available:
        assert row["componentsPartial"] is True

    entry.update({"cacheReadTokens": 40, "unclassifiedTokens": 0 if available else 60})
    partial = merge_trend_with_history([], {"daily": [entry]})[0]
    assert partial["cacheReadTokens"] == 40
    assert partial["total"] == 100
    if not available:
        assert partial["componentsPartial"] is True


@pytest.mark.parametrize("with_models", [False, True])
def test_sqlite_recorded_partial_zero_is_not_reinterpreted_by_history_fallback(with_models):
    snapshot = {
        "day": "2026-09-05", "total": 100,
        "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0,
        "unclassifiedTokens": 100, "tokenComponentsAvailable": False,
        "componentsPartial": True,
    }
    fallback = {"date": "2026-09-05", "tokens": 100, **DETAILS}
    original = copy.deepcopy(snapshot)
    row = merge_trend_with_history(
        [snapshot], {"daily": [fallback]}, with_models=with_models,
    )[0]
    for key, value in snapshot.items():
        assert row[key] == value
    assert snapshot == original


@pytest.mark.parametrize("bad_count", [-1, 1.2, True, "80", float("nan"), float("inf")])
def test_invalid_daily_cache_never_becomes_a_valid_numeric_zero(bad_count):
    row = merge_trend_with_history([], {"daily": [{
        "date": "2026-09-02", "tokens": 100, "cacheReadTokens": bad_count,
        "cost": float("inf"),
    }]})[0]
    assert "cacheReadTokens" not in row
    assert "costUsd" not in row


@requires_node
def test_ingest_to_overview_and_daily_archive_preserves_80_percent_cache(cloud):
    payload = widget_style_payload("cache-regression", tz="UTC")
    period = {"totalTokens": 100, "costUsd": 1.25, **DETAILS,
              "clients": {"codex": 100}, "models": {"test-model": 100},
              "clientOutputs": {"codex": 10}, "modelOutputs": {"test-model": 10},
              "clientCacheReads": {"codex": 80}, "modelCacheReads": {"test-model": 80},
              "clientCacheWrites": {"codex": 5}, "modelCacheWrites": {"test-model": 5},
              "clientUnclassifiedTokens": {"codex": 0},
              "modelUnclassifiedTokens": {"test-model": 0}}
    payload.update({"today": period, "month": period, "allTime": period})
    response = cloud.post("/api/ingest", headers={"X-Token-Monitor-Secret": TM_SECRET}, json=payload)
    assert response.status_code == 200, response.text
    auth = {"Authorization": f"Bearer {READ_KEY}"}
    overview = cloud.get("/api/v1/tm/overview", headers=auth)
    archive = cloud.get("/api/v1/tm/history/daily", headers=auth)
    assert overview.status_code == archive.status_code == 200
    day = payload["periodWindows"]["today"]["key"]
    trend = next(row for row in overview.json()["trend"] if row["day"] == day)
    daily = next(row for row in archive.json()["items"] if row["day"] == day)
    assert trend["cacheReadTokens"] / trend["total"] == 0.8
    assert daily["cacheReadTokens"] / daily["tokens"] == 0.8
    assert trend["costUsd"] == daily["costUsd"] == 1.25
    assert trend["unclassifiedTokens"] == daily["unclassifiedTokens"] == 0
