"""Durable outbox ordering and upstream acceptance are required for replay."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import sqlite3

import httpx
import pytest

from conftest import TM_SECRET, widget_style_payload
from hub.db import Database
from hub import tm_outbox as outbox, tm_snapshots as snapshots


def usage(device='dev', total=100):
    day = datetime.now(timezone.utc).date().isoformat()
    return {'deviceId': device, 'updatedAt': f'{day}T00:00:00.000Z',
            'periodWindows': {'timeZone': 'UTC', 'today': {'key': day}},
            'today': {'totalTokens': total, 'costUsd': total / 100}}


@pytest.fixture
def database(monkeypatch):
    db = Database(':memory:')
    snapshots.ensure_schema(db)
    outbox.ensure_schema(db)
    monkeypatch.setattr(snapshots, 'schedule_prune', lambda db: None)
    yield db
    db.close()


def test_sequence_survives_outbox_pruning_and_snapshot_deletion(database):
    db = database
    for request_id in ('a', 'b'):
        outbox.record_pending(db, request_id=request_id, device_id='dev', payload=usage())
        outbox.mark_done(db, request_id)
    previous = outbox.outbox_ingest_sequence(db, 'b')
    old = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()
    db.execute('UPDATE tm_ingest_outbox SET received_at=?', (old,))
    assert outbox.prune_done(db) == 2
    outbox.ensure_schema(db)  # reopening/reinitializing must not reset the counter
    outbox.record_pending(db, request_id='c', device_id='dev', payload=usage(total=200))
    assert outbox.outbox_ingest_sequence(db, 'c') > previous


def test_counter_upgrade_starts_above_retained_snapshot_sequences(database):
    db = database
    p = usage()
    snapshots.write_snapshot(db, device_id='dev', record=outbox.record_from_payload(p),
                             incoming=p, limits_only=False, ingest_sequence=900)
    outbox.ensure_schema(db)
    outbox.record_pending(db, request_id='new', device_id='dev', payload=usage(total=200))
    sequence = outbox.outbox_ingest_sequence(db, 'new')
    assert sequence > 900
    outbox.save_normalized(db, 'new', outbox.record_from_payload(usage(total=200)))
    assert outbox.replay_pending(db, None)['completed'] == 1
    assert db.fetchone('SELECT today_total FROM tm_snapshot_buckets')['today_total'] == 200


def test_unconfirmed_payload_cannot_be_replayed_before_core_accepts(database):
    db = database
    outbox.record_pending(db, request_id='forwarding', device_id='dev', payload=usage())
    result = outbox.replay_pending(db, None)
    assert result['completed'] == 0
    assert db.fetchone('SELECT COUNT(*) AS n FROM tm_snapshot_buckets')['n'] == 0
    assert outbox.pending_count(db) == 1


def test_unconfirmed_rows_do_not_starve_confirmed_replay(database):
    db = database
    for index in range(100):
        outbox.record_pending(db, request_id=f'unknown-{index}', device_id=f'd{index}', payload=usage(f'd{index}'))
    p = usage('accepted', 321)
    outbox.record_pending(db, request_id='accepted', device_id='accepted', payload=p)
    outbox.save_normalized(db, 'accepted', outbox.record_from_payload(p))
    assert outbox.replay_pending(db, None)['completed'] == 1
    assert db.fetchone("SELECT today_total FROM tm_snapshot_buckets WHERE device_id='accepted'")['today_total'] == 321


@pytest.mark.parametrize('partial', [
    {'limitsOnly': True, 'limits': {'providers': []}},
    {'month': {'totalTokens': 900}},
])
def test_confirmed_partial_update_finishes_without_usage_snapshot(database, partial):
    db = database
    p = {k: v for k, v in usage().items() if k != 'today'} | partial
    outbox.record_pending(db, request_id='partial', device_id='dev', payload=p)
    outbox.save_normalized(db, 'partial', outbox.record_from_payload(p))
    assert outbox.replay_pending(db, None)['completed'] == 1
    assert outbox.pending_count(db) == 0
    assert db.fetchone('SELECT COUNT(*) AS n FROM tm_snapshot_buckets')['n'] == 0


def test_rejected_forwarding_cannot_create_a_ghost_snapshot(cloud, monkeypatch):
    db = cloud.app.state.db
    def reject_after_background_tick(*args, **kwargs):
        outbox.replay_pending(db, None)
        return httpx.Response(503, json={'error': 'persistence_failed'})
    monkeypatch.setattr(cloud.app.state.tm_core, 'request', reject_after_background_tick)
    response = cloud.post('/api/ingest', json=widget_style_payload('never-accepted'),
                          headers={'X-Token-Monitor-Secret': TM_SECRET})
    assert response.status_code == 503
    assert db.fetchone("SELECT COUNT(*) AS n FROM tm_snapshot_buckets WHERE device_id='never-accepted'")['n'] == 0
    assert outbox.pending_count(db) == 0


def test_ack_storage_failure_returns_retryable_response(cloud, monkeypatch):
    import hub.tm_proxy as proxy
    outbox.set_snapshot_status(cloud.app.state.db, success=True)
    def unavailable(*args, **kwargs):
        raise sqlite3.OperationalError('temporary acknowledgement storage failure')
    monkeypatch.setattr(proxy, 'save_normalized', unavailable)
    response = cloud.post('/api/ingest', json=widget_style_payload('retry-ack'),
                          headers={'X-Token-Monitor-Secret': TM_SECRET})
    assert response.status_code == 503
    assert cloud.app.state.db.fetchone("SELECT normalized_json FROM tm_ingest_outbox WHERE device_id='retry-ack'") is None
    assert outbox.snapshot_health(cloud.app.state.db)['snapshot_degraded'] is True


def test_saved_ack_omits_session_volume_and_keeps_snapshot_fields(database):
    import json
    db = database
    p = usage()
    p['today'].update({'cacheReadTokens': 20, 'models': {'m': 100}, 'sessions': {'large': 'x' * 10000}})
    p['month'] = {'totalTokens': 900, 'costUsd': 9, 'sessions': {'large': 'x' * 10000}}
    p['allTime'] = {'totalTokens': 9000, 'costUsd': 90, 'projects': {'large': 'x' * 10000}}
    outbox.record_pending(db, request_id='compact', device_id='dev', payload=p)
    outbox.save_normalized(db, 'compact', outbox.record_from_payload(p))
    raw = db.fetchone('SELECT normalized_json FROM tm_ingest_outbox')['normalized_json']
    assert len(raw) < 2000
    record = json.loads(raw)
    assert record['periods']['today']['cacheReadTokens'] == 20
    assert record['periods']['today']['models'] == {'m': 100}
    assert record['periods']['month']['totalTokens'] == 900
    assert record['periods']['allTime']['costUsd'] == 90


@pytest.mark.parametrize('cross_day', [False, True], ids=['same-second', 'cross-day'])
def test_real_core_replay_preserves_the_acknowledged_total_cost_and_model(cloud, monkeypatch, cross_day):
    import hub.tm_proxy as proxy
    db = cloud.app.state.db
    today = datetime.now(timezone.utc).date()
    day_a = today - timedelta(days=1) if cross_day else today
    first = widget_style_payload('replay-values', tz='UTC', day=day_a.isoformat())
    first['updatedAt'] = f'{day_a.isoformat()}T00:00:00.000Z'
    first['today'] = {'totalTokens': 900 if cross_day else 100,
                      'costUsd': 9 if cross_day else 1,
                      'models': {'first': 900 if cross_day else 100}}
    second = widget_style_payload('replay-values', tz='UTC', day=today.isoformat())
    second['updatedAt'] = f'{today.isoformat()}T00:00:00.000Z'
    second['today'] = {'totalTokens': 100 if cross_day else 200,
                       'costUsd': 1 if cross_day else 2,
                       'models': {'second': 100 if cross_day else 200}}
    original = proxy.write_snapshot
    def unavailable(*args, **kwargs):
        raise sqlite3.OperationalError('temporary snapshot failure after acceptance')
    # Force outbox receipt precision to the same second as the successful snapshot.
    stamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    monkeypatch.setattr(outbox, 'utc_now', lambda: stamp)
    for index, payload in enumerate((first, second)):
        fail = index == (0 if cross_day else 1)
        monkeypatch.setattr(proxy, 'write_snapshot', unavailable if fail else original)
        response = cloud.post('/api/ingest', json=payload,
                              headers={'X-Token-Monitor-Secret': TM_SECRET})
        assert response.status_code == 200
    monkeypatch.setattr(proxy, 'write_snapshot', original)
    result = outbox.replay_pending(db, None)
    assert result['completed'] == 1
    assert result['superseded'] == 0
    import json
    rows = {row['local_day']: row for row in db.fetchall(
        "SELECT local_day, today_total, today_cost, models_json FROM tm_snapshot_buckets WHERE device_id='replay-values'"
    )}
    expected = ((day_a, first), (today, second)) if cross_day else ((today, second),)
    for day, payload in expected:
        actual = rows[day.isoformat()]
        assert actual['today_total'] == payload['today']['totalTokens']
        assert actual['today_cost'] == payload['today']['costUsd']
        assert json.loads(actual['models_json']) == payload['today']['models']


def test_unknown_rows_keep_health_degraded_without_exhausting_ready_queue_capacity(database):
    db = database
    for index in range(3):
        outbox.record_pending(db, request_id=f'unknown-{index}', device_id='dev', payload=usage(), max_pending=1)
    state = outbox.snapshot_health(db)
    assert state['unconfirmed_outbox'] == state['pending_outbox'] == 3
    assert state['snapshot_degraded'] is True
    outbox.record_pending(db, request_id='accepted', device_id='dev', payload=usage(), max_pending=1)
    outbox.save_normalized(db, 'accepted', outbox.record_from_payload(usage()))
    with pytest.raises(outbox.OutboxFullError):
        outbox.record_pending(db, request_id='over-capacity', device_id='dev', payload=usage(), max_pending=1)
