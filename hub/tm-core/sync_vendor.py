#!/usr/bin/env python3
"""Verify or restore the byte-for-byte, pinned v0.62.0 Hub dependency closure.

The lock is deliberately committed separately from the generated vendor manifest.
No downloads or npm installation are performed. A future release needs a reviewed
lock update; passing a different source directory cannot silently change the pin.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PIN = "dcccfb01557e2786888fd5479552f392ac6c0d32"
REQUIRE = re.compile(r"require\(['\"]([^'\"]+)['\"]\)")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def closure(root: Path, entries: list[str]) -> set[str]:
    pending = list(entries)
    found: set[str] = set()
    while pending:
        relative = pending.pop()
        if relative in found:
            continue
        path = (root / relative).resolve()
        path.relative_to(root.resolve())  # Reject a dependency escaping the source.
        if not path.is_file():
            raise ValueError(f"Missing dependency: {relative}")
        found.add(relative)
        if path.suffix != ".js":
            continue
        for target in REQUIRE.findall(path.read_text(encoding="utf-8")):
            if not target.startswith("."):
                continue
            candidate = path.parent / target
            resolved = next((p for p in (
                candidate, candidate.with_suffix(".js"),
                candidate.with_suffix(".json"), candidate / "index.js"
            ) if p.is_file()), None)
            if resolved is None:
                raise ValueError(f"Unresolved dependency: {relative}: {target}")
            pending.append(str(resolved.resolve().relative_to(root.resolve())))
    return found


def manifest(lock: dict) -> str:
    return ("# Vendor integrity manifest\n"
            f"upstream: {lock['upstream']}\nrelease: {lock['release']}\n"
            f"commit: {lock['commit']}\nlicense: MIT (LICENSE-token-monitor)\n\nfiles:\n"
            + "".join(f"{sha}  {path}\n" for path, sha in lock["files"].items()))


def verify(root: Path, lock: dict, *, vendor: bool) -> None:
    if lock["commit"] != PIN or lock["release"] != "v0.62.0":
        raise ValueError("The reviewed v0.62.0 source pin was changed")
    expected = set(lock["files"])
    actual = closure(root, lock["entries"])
    if actual != expected:
        raise ValueError(f"Dependency closure differs: {sorted(actual ^ expected)}")
    for relative, sha in lock["files"].items():
        if digest(root / relative) != sha:
            raise ValueError(f"Pinned source hash differs: {relative}")
    license_path = root / ("LICENSE-token-monitor" if vendor else "LICENSE")
    if digest(license_path) != lock["licenseSha256"]:
        raise ValueError("Upstream license hash differs")
    if vendor:
        installed = {str(p.relative_to(root)) for p in (root / "src").rglob("*") if p.is_file()}
        if installed != expected:
            raise ValueError(f"Unexpected vendor source files: {sorted(installed ^ expected)}")
        if (root / "MANIFEST.txt").read_text() != manifest(lock):
            raise ValueError("Generated vendor manifest differs")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--source", type=Path, help="Extracted official v0.62.0 source directory")
    args = parser.parse_args()
    lock = json.loads((ROOT / "upstream-v062.json").read_text())
    target = ROOT / "vendor"
    if args.source:
        source = args.source.resolve()
        if (source.is_relative_to(target.resolve())
                or target.resolve().is_relative_to(source)):
            raise ValueError("Source must be separate from the destination vendor directory")
        verify(source, lock, vendor=False)  # Finish every check before writing.
        for path in (target / "src").rglob("*"):
            if path.is_file() and str(path.relative_to(target)) not in lock["files"]:
                path.unlink()
        for relative in lock["files"]:
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / relative, destination)
        shutil.copyfile(source / "LICENSE", target / "LICENSE-token-monitor")
        (target / "MANIFEST.txt").write_text(manifest(lock))
    verify(target, lock, vendor=True)
    print(f"Verified {lock['release']} ({PIN}): {len(lock['files'])} source files and MIT license")


if __name__ == "__main__":
    main()
