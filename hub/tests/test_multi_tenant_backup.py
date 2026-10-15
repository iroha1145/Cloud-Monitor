"""Backup helpers work on disk state, including tenants removed from config."""

import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess

import pytest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
SPEC = importlib.util.spec_from_file_location("backup_data", SCRIPTS / "backup_data.py")
backup_data = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup_data)


def write_db(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    try:
        connection.execute("CREATE TABLE usage (device TEXT PRIMARY KEY, tokens INTEGER)")
        connection.execute("INSERT INTO usage VALUES ('same-device', ?)", (value,))
        connection.commit()
    finally:
        connection.close()


def read_db(path):
    connection = sqlite3.connect(path)
    try:
        return connection.execute("SELECT tokens FROM usage WHERE device='same-device'").fetchone()[0]
    finally:
        connection.close()


def make_backup(path, tenants=("alice", "bob")):
    path.mkdir()
    (path / "devices.json").write_text('{"devices":{"same-device":{"tokens":10}}}', encoding="utf-8")
    write_db(path / "cloud-monitor.sqlite3", 10)
    for index, tenant in enumerate(tenants, 20):
        directory = path / "tenants" / tenant
        directory.mkdir(parents=True)
        (directory / "devices.json").write_text(json.dumps({"devices": {"same-device": {"tokens": index}}}), encoding="utf-8")
        write_db(directory / "hub.sqlite3", index)
    return path


def symlink(path, target, *, directory=False):
    try:
        path.symlink_to(target, target_is_directory=directory)
    except OSError as error:
        pytest.skip(f"Symlink creation unavailable: {error}")


def test_tm_copy_keeps_all_on_disk_tenants_and_omits_configuration(tmp_path):
    source, output = tmp_path / "tm-volume", tmp_path / "backup"
    source.mkdir()
    output.mkdir()
    (source / "devices.json").write_text('{"root":10}', encoding="utf-8")
    (source / ".env").write_text("SECRET=must-not-be-copied", encoding="utf-8")
    for tenant, value in (("alice", 20), ("bob", 30), ("removed-from-config", 40)):
        directory = source / "tenants" / tenant
        directory.mkdir(parents=True)
        (directory / "devices.json").write_text(json.dumps({"same-device": value}), encoding="utf-8")
    (source / "tenants" / "hub-only").mkdir()

    backup_data.copy_tm_state(source, output)
    assert json.loads((output / "devices.json").read_text()) == {"root": 10}
    assert not (output / ".env").exists()
    assert sorted(p.name for p in (output / "tenants").iterdir()) == ["alice", "bob", "removed-from-config"]
    for tenant, value in (("alice", 20), ("bob", 30), ("removed-from-config", 40)):
        path = output / "tenants" / tenant / "devices.json"
        assert json.loads(path.read_text()) == {"same-device": value}
        if os.name != "nt":
            assert path.stat().st_mode & 0o777 == 0o600


def test_tm_copy_before_first_default_ingest_has_empty_root_state(tmp_path):
    source, output = tmp_path / "tm-volume", tmp_path / "backup"
    source.mkdir()
    output.mkdir()
    backup_data.copy_tm_state(source, output)
    assert json.loads((output / "devices.json").read_text()) == {}


def test_sqlite_snapshot_includes_committed_wal_without_crossing_tenants(tmp_path):
    source = tmp_path / "hub-volume"
    source.mkdir()
    connections = []
    try:
        for tenant, value in (("alice", 20), ("bob", 30), ("removed-from-config", 40)):
            path = source / "tenants" / tenant / "hub.sqlite3"
            write_db(path, 0)
            connection = sqlite3.connect(path)
            connections.append(connection)
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("UPDATE usage SET tokens=?", (value,))
            connection.commit()
            assert Path(str(path) + "-wal").stat().st_size > 0
        (source / "tenants" / "tm-only").mkdir()
        paths = backup_data.tenant_files(source, "hub.sqlite3")
        assert [tenant for tenant, _path in paths] == ["alice", "bob", "removed-from-config"]
        for (tenant, path), expected in zip(paths, (20, 30, 40)):
            output = io.BytesIO()
            backup_data.sqlite_snapshot(path, output)
            snapshot = tmp_path / f"{tenant}.sqlite3"
            snapshot.write_bytes(output.getvalue())
            assert read_db(snapshot) == expected
            assert not Path(str(snapshot) + "-wal").exists()
    finally:
        for connection in connections:
            connection.close()


def test_hub_restore_keeps_databases_separate_and_legacy_preserves_tenants(tmp_path, monkeypatch):
    backup = make_backup(tmp_path / "backup", ("alice", "bob", "removed-from-config"))
    data = tmp_path / "hub-volume"
    write_db(data / "cloud-monitor.sqlite3", -1)
    write_db(data / "tenants" / "untouched" / "hub.sqlite3", 99)
    for tenant in ("alice", "bob"):
        directory = data / "tenants" / tenant
        directory.mkdir()
        (directory / "hub.sqlite3-wal").write_bytes(b"stale")
        (directory / "hub.sqlite3-shm").write_bytes(b"stale")
    owners = []
    monkeypatch.setattr(backup_data.os, "chown", lambda path, uid, gid: owners.append((Path(path), uid, gid)), raising=False)

    backup_data.restore_hub(backup, data, 123, 456)
    assert read_db(data / "cloud-monitor.sqlite3") == 10
    for tenant, expected in (("alice", 20), ("bob", 21), ("removed-from-config", 22), ("untouched", 99)):
        path = data / "tenants" / tenant / "hub.sqlite3"
        assert read_db(path) == expected
        assert not Path(str(path) + "-wal").exists()
        assert not Path(str(path) + "-shm").exists()
    assert {(uid, gid) for _path, uid, gid in owners} == {(123, 456)}
    assert any(path == data / "tenants" / "alice" for path, _uid, _gid in owners)

    legacy = make_backup(tmp_path / "legacy", ())
    write_db(tmp_path / "replacement.sqlite3", 77)
    (legacy / "cloud-monitor.sqlite3").write_bytes((tmp_path / "replacement.sqlite3").read_bytes())
    before = {path: path.read_bytes() for path in (data / "tenants").glob("*/hub.sqlite3")}
    backup_data.restore_hub(legacy, data, 123, 456)
    assert read_db(data / "cloud-monitor.sqlite3") == 77
    assert all(path.read_bytes() == original for path, original in before.items())


def test_validation_accepts_standalone_wal_database_in_readonly_backup(tmp_path):
    backup = make_backup(tmp_path / "backup", ())
    database = backup / "cloud-monitor.sqlite3"
    connection = sqlite3.connect(database)
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("UPDATE usage SET tokens=77")
        connection.commit()
    finally:
        connection.close()
    assert database.read_bytes()[18] == 2
    before = sorted(path.name for path in backup.iterdir())
    database.chmod(0o400)
    backup.chmod(0o500)
    try:
        backup_data.validate_backup(backup)
        assert sorted(path.name for path in backup.iterdir()) == before
    finally:
        backup.chmod(0o700)
        database.chmod(0o600)


@pytest.mark.parametrize("tenant", ["default", "..", "../alice", "alice/bob", "alice\\bob", "bad name", "x" * 65, "alice\n"])
def test_rejects_invalid_tenant_ids(tenant):
    with pytest.raises(ValueError, match="tenant id"):
        backup_data.validate_tenant_id(tenant)


@pytest.mark.parametrize("kind", ["root-json", "tenant-directory", "tenant-db"])
def test_backup_validation_rejects_symlinks(tmp_path, kind):
    backup = make_backup(tmp_path / "backup")
    if kind == "root-json":
        outside = tmp_path / "outside.json"
        outside.write_text("{}", encoding="utf-8")
        (backup / "devices.json").unlink()
        symlink(backup / "devices.json", outside)
    elif kind == "tenant-directory":
        symlink(backup / "tenants" / "escape", tmp_path, directory=True)
    else:
        target = backup / "tenants" / "alice" / "hub.sqlite3"
        target.unlink()
        symlink(target, backup / "cloud-monitor.sqlite3")
    with pytest.raises(ValueError, match="symlink"):
        backup_data.validate_backup(backup)


def test_backup_validation_rejects_invalid_disk_tenant_and_corrupt_sqlite(tmp_path):
    backup = make_backup(tmp_path / "backup")
    invalid = backup / "tenants" / "bad name"
    invalid.mkdir()
    with pytest.raises(ValueError, match="tenant id"):
        backup_data.validate_backup(backup)
    invalid.rmdir()
    (backup / "tenants" / "alice" / "hub.sqlite3").write_bytes(b"not sqlite")
    with pytest.raises(sqlite3.DatabaseError):
        backup_data.validate_backup(backup)


def test_hub_restore_rejects_destination_symlink_before_changing_root(tmp_path):
    backup = make_backup(tmp_path / "backup")
    data = tmp_path / "hub-volume"
    write_db(data / "cloud-monitor.sqlite3", -1)
    (data / "tenants").mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    symlink(data / "tenants" / "alice", outside, directory=True)
    with pytest.raises(ValueError, match="symlink"):
        backup_data.restore_hub(backup, data, 123, 456)
    assert read_db(data / "cloud-monitor.sqlite3") == -1
    assert not list(outside.iterdir())


@pytest.mark.skipif(os.name == "nt", reason="The restoration container uses POSIX sh and chown")
def test_tm_restore_separates_tenants_and_legacy_does_not_delete_them(tmp_path):
    backup = make_backup(tmp_path / "backup", ("alice", "bob", "removed-from-config"))
    data = tmp_path / "tm-volume"
    data.mkdir()

    def restore(source):
        result = subprocess.run(
            ["sh", str(SCRIPTS / "restore_tm.sh"), str(source), str(data), str(os.getuid()), str(os.getgid())],
            capture_output=True, text=True,
        )
        assert result.returncode == 0, result.stderr

    restore(backup)
    assert json.loads((data / "devices.json").read_text())["devices"]["same-device"]["tokens"] == 10
    for tenant, expected in (("alice", 20), ("bob", 21), ("removed-from-config", 22)):
        path = data / "tenants" / tenant / "devices.json"
        assert json.loads(path.read_text())["devices"]["same-device"]["tokens"] == expected
        assert path.stat().st_uid == os.getuid()
        assert path.stat().st_gid == os.getgid()
    legacy = make_backup(tmp_path / "legacy", ())
    before = {path: path.read_bytes() for path in (data / "tenants").glob("*/devices.json")}
    restore(legacy)
    assert all(path.read_bytes() == content for path, content in before.items())


@pytest.mark.skipif(os.name == "nt", reason="The restore entrypoint is a POSIX shell script")
def test_restore_never_falls_back_to_another_projects_volume(tmp_path):
    backup = make_backup(tmp_path / "backup", ())
    binaries = tmp_path / "bin"
    binaries.mkdir()
    events = tmp_path / "events"
    docker = binaries / "docker"
    docker.write_text("""#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['BACKUP_TEST_EVENTS'], 'a') as output:
    output.write(json.dumps(args) + '\\n')
if 'config' in args:
    print(json.dumps({'volumes': {'tm-core-data': {'name': 'current_tm-core-data'}, 'cloud-hub-data': {'name': 'current_cloud-hub-data'}}}))
elif 'run' in args and '--help' in args:
    print('--cap-add')
elif args[:2] == ['volume', 'inspect']:
    sys.exit(0 if args[2].startswith('hub_') else 1)
""", encoding="utf-8")
    docker.chmod(0o755)
    result = subprocess.run(
        ["bash", str(SCRIPTS / "restore.sh"), str(backup)],
        env={**os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"], "BACKUP_TEST_EVENTS": str(events)},
        capture_output=True, text=True,
    )
    assert result.returncode == 1
    assert "current_tm-core-data" in result.stderr
    calls = [json.loads(line) for line in events.read_text().splitlines()]
    assert [call for call in calls if call[:2] == ["volume", "inspect"]] == [["volume", "inspect", "current_tm-core-data"]]
    assert not any("down" in call for call in calls)
