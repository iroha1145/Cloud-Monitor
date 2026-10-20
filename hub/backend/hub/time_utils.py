"""Shared timezone-aware timestamp helpers for Token Monitor."""
from __future__ import annotations

from datetime import datetime, timezone


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def parse_iso_datetime(raw: str) -> datetime:
    """Parse an ISO 8601 string into an aware datetime.

    Normalizes a trailing Z and treats a naive value as UTC. An explicit
    offset is left intact so callers that read the calendar date keep the
    original wall day.
    """
    text = raw.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def iso_to_utc(raw: str) -> datetime:
    """Parse an ISO 8601 string into a UTC-aware datetime.

    Raises ValueError or OverflowError on malformed or unrepresentable input.
    """
    return parse_iso_datetime(raw).astimezone(timezone.utc)
