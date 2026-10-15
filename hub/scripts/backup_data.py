#!/usr/bin/env python3
"""Filesystem checks and SQLite snapshots for the two Cloud Monitor volumes."""

import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import sys
import tempfile


TENANT_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")


def validate_tenant_id(value):
    if not TENANT_ID.fullmatch(value) or value == "default":
        raise ValueError(f"Invalid tenant id: {value!r}")


def check_directory(path):
    if path.is_symlink() or not path.is_dir():
        raise ValueError(f"Expected a directory without symlinks: {path}")


def check_file(path):
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError(f"Expected a regular file without symlinks: {path}")


def tenant_files(root, filename):
    directory = root / "tenants"
    if not directory.exists() and not directory.is_symlink():
        return []
    check_directory(directory)
    files = []
    for tenant in sorted(directory.iterdir()):
        validate_tenant_id(tenant.name)
        check_directory(tenant)
        path = tenant / filename
        if path.exists() or path.is_symlink():
            check_file(path)
            files.append((tenant.name, path))
    return files


def copy_tm_state(source, output):
    check_directory(source)
    root_file = source / "devices.json"
    files = tenant_files(source, "devices.json")
    if root_file.exists() or root_file.is_symlink():
        check_file(root_file)
        shutil.copyfile(root_file, output / "devices.json")
    else:
        (output / "devices.json").write_text("{}\n", encoding="utf-8")
    (output / "devices.json").chmod(0o600)
    for tenant_id, path in files:
        (output / "tenants").mkdir(mode=0o700, exist_ok=True)
        directory = output / "tenants" / tenant_id
        directory.mkdir(mode=0o700, exist_ok=True)
        destination = directory / "devices.json"
        shutil.copyfile(path, destination)
        destination.chmod(0o600)


def sqlite_snapshot(source, output):
    for path in (source, *source.parents):
        if path.is_symlink():
            raise ValueError(f"Refusing symlink SQLite path: {path}")
    check_file(source)
    with tempfile.TemporaryDirectory(prefix="cm-backup-") as directory:
        snapshot = Path(directory) / "snapshot.sqlite3"
        src = sqlite3.connect(source.absolute().as_uri() + "?mode=ro", uri=True)
        dst = sqlite3.connect(snapshot)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        with snapshot.open("rb") as handle:
            shutil.copyfileobj(handle, output)


def validate_backup(root):
    check_directory(root)
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in (*dirs, *files):
            if (Path(directory) / name).is_symlink():
                raise ValueError(f"Refusing symlink in backup: {Path(directory) / name}")
    json_files = [root / "devices.json", *(path for _, path in tenant_files(root, "devices.json"))]
    databases = [root / "cloud-monitor.sqlite3", *(path for _, path in tenant_files(root, "hub.sqlite3"))]
    for path in json_files:
        check_file(path)
        with path.open(encoding="utf-8") as handle:
            if not isinstance(json.load(handle), dict):
                raise ValueError(f"Expected JSON object: {path}")
    for path in databases:
        check_file(path)
        # These are standalone .backup files, mounted read-only during restore.
        # Avoid creating WAL/SHM beside snapshots whose source used WAL mode.
        connection = sqlite3.connect(path.absolute().as_uri() + "?mode=ro&immutable=1", uri=True)
        try:
            if connection.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                raise ValueError(f"SQLite validation failed: {path}")
        finally:
            connection.close()


def restore_hub(backup, data, uid, gid):
    validate_backup(backup)
    check_directory(data)
    sources = [(backup / "cloud-monitor.sqlite3", data / "cloud-monitor.sqlite3")]
    sources.extend((source, data / "tenants" / tenant / "hub.sqlite3") for tenant, source in tenant_files(backup, "hub.sqlite3"))
    # Check every destination before changing any database.
    for _source, destination in sources:
        for directory in (destination.parent, *destination.parent.parents):
            if directory == data.parent:
                break
            if directory.exists() or directory.is_symlink():
                check_directory(directory)
        for path in (destination, Path(str(destination) + "-wal"), Path(str(destination) + "-shm")):
            if path.exists() or path.is_symlink():
                check_file(path)
    for source, destination in sources:
        if destination.parent != data:
            (data / "tenants").mkdir(mode=0o700, exist_ok=True)
            destination.parent.mkdir(mode=0o700, exist_ok=True)
            os.chown(data / "tenants", uid, gid)
            os.chown(destination.parent, uid, gid)
        fd, temporary = tempfile.mkstemp(prefix=".cm-restore-", dir=destination.parent)
        try:
            with os.fdopen(fd, "wb") as output, source.open("rb") as handle:
                shutil.copyfileobj(handle, output)
            os.chown(temporary, uid, gid)
            os.replace(temporary, destination)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        for suffix in ("-wal", "-shm"):
            Path(str(destination) + suffix).unlink(missing_ok=True)


def main():
    command = sys.argv[1]
    if command == "copy-tm":
        copy_tm_state(Path(sys.argv[2]), Path(sys.argv[3]))
    elif command == "list-hub":
        for tenant, _path in tenant_files(Path(sys.argv[2]), "hub.sqlite3"):
            print(tenant)
    elif command == "snapshot":
        sqlite_snapshot(Path(sys.argv[2]), sys.stdout.buffer)
    elif command == "validate":
        validate_backup(Path(sys.argv[2]))
    elif command == "restore-hub":
        import pwd

        monitor = pwd.getpwnam("monitor")
        restore_hub(Path(sys.argv[2]), Path(sys.argv[3]), monitor.pw_uid, monitor.pw_gid)
    else:
        raise ValueError(f"Unknown backup operation: {command}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, sqlite3.Error) as error:
        raise SystemExit(str(error))
