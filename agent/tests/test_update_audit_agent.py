"""Agent regressions paired with the hub's 500-user request bound."""

from datetime import datetime, timedelta, timezone
import json

import pytest

import sync_agent as sa
from test_agent import AgentState, FakeSession, _cursor_round_routes, make_agent, make_config, ok_push, rec


def large_user_agent(tmp_path):
    config = make_config(tmp_path)
    state = AgentState(config.state_path)
    state.device_id = config.device_id
    session = FakeSession()
    users = [{"id": f"u{index}", "name": f"User {index}"} for index in range(1001)]
    _cursor_round_routes(session, [{"records": [rec(1)]}, {"records": []}], users=users)
    agent = make_agent(config, state, session)
    return agent, session, state


def test_1001_users_are_bounded_without_losing_first_chunk_record_counts(tmp_path):
    agent, session, state = large_user_agent(tmp_path)

    def accept(_url, kwargs):
        payload = kwargs["json"]
        assert len(payload["users"]) <= 500
        assert state.data.get("last_users_push_at") is None
        return ok_push(len(payload["records"]), users_upserted=len(payload["users"]))

    session.route("POST", "/api/v1/sync/push", accept)
    result = agent.run_once()
    pushes = [call[2]["json"] for call in session.calls if call[0] == "POST"]
    assert [len(push["users"]) for push in pushes] == [500, 500, 1]
    assert [len(push["records"]) for push in pushes] == [1, 0, 0]
    assert result["inserted"] == 1
    assert state.cursor == 1
    assert state.data["pushed_records"] == 1
    persisted = json.loads(agent.config.state_path.read_text())
    assert persisted["last_users_digest"] == persisted["users_digest"]
    assert persisted["last_users_push_at"]


@pytest.mark.parametrize("unchanged", [False, True])
@pytest.mark.parametrize("failure", ["transient", "bad_response"])
def test_partial_user_upload_does_not_acknowledge_digest_or_refresh_timer(tmp_path, unchanged, failure):
    agent, session, state = large_user_agent(tmp_path)
    agent.fetch_users()
    current_digest = state.data["users_digest"]
    previous_digest = current_digest if unchanged else "previous-user-digest"
    previous_time = (datetime.now(timezone.utc) - timedelta(hours=7)).isoformat()
    state.data["last_users_digest"] = previous_digest
    state.data["last_users_push_at"] = previous_time
    state.save()
    calls = 0

    def fail_second(_url, kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            if failure == "transient":
                raise sa.TransientError("temporary upload failure")
            return ok_push(99)
        payload = kwargs["json"]
        return ok_push(len(payload["records"]), users_upserted=len(payload["users"]))

    session.route("POST", "/api/v1/sync/push", fail_second)
    with pytest.raises((sa.TransientError, ValueError)):
        agent.run_once()
    assert state.cursor == 0
    assert state.data["last_users_digest"] == previous_digest
    assert state.data["last_users_push_at"] == previous_time
    persisted = json.loads(agent.config.state_path.read_text())
    assert persisted["last_users_digest"] == previous_digest
    assert persisted["last_users_push_at"] == previous_time

    session.calls.clear()
    session.route("POST", "/api/v1/sync/push", lambda _url, kwargs: ok_push(
        len(kwargs["json"]["records"]), users_upserted=len(kwargs["json"]["users"])
    ))
    agent.run_once()
    pushes = [call[2]["json"] for call in session.calls if call[0] == "POST"]
    assert [len(push["users"]) for push in pushes] == [500, 500, 1]
    assert state.data["last_users_digest"] == current_digest
    assert state.data["last_users_push_at"] != previous_time
    assert state.cursor == 1


def test_attribute_error_is_not_reclassified_as_a_transient_sync_failure(tmp_path, monkeypatch):
    agent, _session, state = large_user_agent(tmp_path)
    monkeypatch.setattr(sa.signal, "signal", lambda *_args: None)

    def programming_error():
        raise AttributeError("missing implementation attribute")

    monkeypatch.setattr(agent, "run_once", programming_error)
    with pytest.raises(AttributeError, match="missing implementation"):
        agent.run_forever()
    assert state.data.get("last_error_type") is None
