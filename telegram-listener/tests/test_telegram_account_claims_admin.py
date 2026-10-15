"""Admin override for the one-Telegram-per-account claim rule."""

from __future__ import annotations

import os
from types import SimpleNamespace

from app.admin_access import is_admin_access_active, user_is_admin
from app.telegram_account_claims import (
    TELEGRAM_ALREADY_LINKED,
    claim_conflict_allows_override,
    list_conflicting_telegram_claims,
    release_conflicting_telegram_claims,
    restore_telegram_account_claims,
)

PHONE = "+441111111111"
OTHER_PHONE = "+442222222222"


class FakeQuery:
    def __init__(self, db: "FakeSupabase") -> None:
        self.db = db
        self.op: str | None = None
        self.filters: dict[str, object] = {}
        self.payload: object = None
        self.single = False

    def select(self, *_args: object, **_kwargs: object) -> "FakeQuery":
        self.op = "select"
        return self

    def eq(self, column: str, value: object) -> "FakeQuery":
        self.filters[column] = value
        return self

    def delete(self) -> "FakeQuery":
        self.op = "delete"
        return self

    def in_(self, column: str, values: object) -> "FakeQuery":
        self.filters[column] = values
        return self

    def insert(self, payload: object) -> "FakeQuery":
        self.op = "insert"
        self.payload = payload
        return self

    def maybe_single(self) -> "FakeQuery":
        self.single = True
        return self

    def execute(self) -> SimpleNamespace:
        self.db.calls.append(
            {
                "op": self.op,
                "filters": dict(self.filters),
                "payload": self.payload,
            }
        )
        if self.op == "select":
            matched = [
                row
                for row in self.db.rows
                if all(str(row.get(col)) == str(val) for col, val in self.filters.items())
            ]
            if self.single:
                return SimpleNamespace(data=matched[0] if matched else None)
            return SimpleNamespace(data=matched)
        if self.op == "delete":
            ids = self.filters.get("user_id") or []
            self.db.rows = [row for row in self.db.rows if row["user_id"] not in ids]
            return SimpleNamespace(data=None)
        if self.op == "insert":
            payload = self.payload
            self.db.rows.extend(payload if isinstance(payload, list) else [payload])
            return SimpleNamespace(data=None)
        return SimpleNamespace(data=[])


class FakeSupabase:
    def __init__(self, rows: list[dict] | None = None) -> None:
        self.rows: list[dict] = list(rows or [])
        self.calls: list[dict] = []

    def table(self, _name: str) -> FakeQuery:
        return FakeQuery(self)


def claim(user_id: str, phone: str, telegram_user_id: int | None) -> dict:
    return {
        "user_id": user_id,
        "phone_number_normalized": phone,
        "telegram_user_id": telegram_user_id,
        "linked_at": "2026-01-01T00:00:00+00:00",
    }


def test_list_conflicting_claims_returns_other_owners():
    db = FakeSupabase(
        [claim("owner-phone", PHONE, 111), claim("owner-id", OTHER_PHONE, 222)]
    )
    conflicts = list_conflicting_telegram_claims(
        db, "me", phone=PHONE, telegram_user_id=222
    )
    assert [row["user_id"] for row in conflicts] == ["owner-phone", "owner-id"]


def test_list_conflicting_claims_ignores_own_row():
    db = FakeSupabase([claim("me", PHONE, 999)])
    assert list_conflicting_telegram_claims(db, "me", phone=PHONE, telegram_user_id=999) == []


def test_release_deletes_conflicting_rows_and_returns_them():
    db = FakeSupabase(
        [
            claim("me", PHONE, 999),
            claim("owner-phone", PHONE, 111),
            claim("owner-id", OTHER_PHONE, 222),
        ]
    )
    released = release_conflicting_telegram_claims(
        db, "me", phone=PHONE, telegram_user_id=222
    )
    assert [row["user_id"] for row in released] == ["owner-phone", "owner-id"]
    deletes = [call for call in db.calls if call["op"] == "delete"]
    assert len(deletes) == 1
    assert deletes[0]["filters"]["user_id"] == ["owner-phone", "owner-id"]
    assert [row["user_id"] for row in db.rows] == ["me"]


def test_release_writes_nothing_when_the_account_is_free():
    db = FakeSupabase([claim("me", PHONE, 999)])
    assert release_conflicting_telegram_claims(db, "me", phone=PHONE, telegram_user_id=999) == []
    assert [call for call in db.calls if call["op"] in ("delete", "insert")] == []


def test_restore_reinserts_released_rows():
    db = FakeSupabase()
    released = [claim("owner-phone", PHONE, 111)]
    restore_telegram_account_claims(db, released)
    assert db.rows == released


def test_restore_is_a_no_op_without_rows():
    db = FakeSupabase([claim("owner-phone", PHONE, 111)])
    restore_telegram_account_claims(db, [])
    assert db.calls == []


def test_admin_from_environment_list():
    os.environ["TSCOPIER_ADMIN_USER_IDS"] = "admin-1, admin-2"
    try:
        assert user_is_admin(FakeSupabase(), "admin-1") is True
        assert user_is_admin(FakeSupabase(), "someone-else") is False
    finally:
        del os.environ["TSCOPIER_ADMIN_USER_IDS"]


def test_admin_from_profile_row():
    db = FakeSupabase(
        [{"user_id": "admin-1", "is_admin": True, "admin_until": None}]
    )
    assert user_is_admin(db, "admin-1") is True
    assert user_is_admin(db, "nobody") is False


def test_admin_access_expires_at_admin_until():
    assert is_admin_access_active({"is_admin": True, "admin_until": None}) is True
    assert is_admin_access_active({"is_admin": True, "admin_until": "2000-01-01T00:00:00+00:00"}) is False
    assert is_admin_access_active({"is_admin": False, "admin_until": None}) is False
    assert is_admin_access_active(None) is False


def test_profile_read_failure_denies_access():
    class BrokenSupabase:
        def table(self, _name: str):
            raise RuntimeError("database unreachable")

    assert user_is_admin(BrokenSupabase(), "admin-1") is False


def test_override_only_applies_to_the_already_linked_refusal():
    os.environ["TSCOPIER_ADMIN_USER_IDS"] = "admin-1"
    try:
        # The real refusal opens the door for an admin...
        assert (
            claim_conflict_allows_override(
                FakeSupabase(), "admin-1", ValueError(TELEGRAM_ALREADY_LINKED)
            )
            is True
        )
        # ... and stays shut for everyone else.
        assert (
            claim_conflict_allows_override(
                FakeSupabase(), "someone-else", ValueError(TELEGRAM_ALREADY_LINKED)
            )
            is False
        )
    finally:
        del os.environ["TSCOPIER_ADMIN_USER_IDS"]


def test_a_database_problem_is_never_treated_as_a_claim_conflict():
    os.environ["TSCOPIER_ADMIN_USER_IDS"] = "admin-1"
    try:
        # Even an admin must see the original error re-raised, never a wave-through.
        assert (
            claim_conflict_allows_override(
                FakeSupabase(), "admin-1", ValueError("database unreachable")
            )
            is False
        )
        assert (
            claim_conflict_allows_override(
                FakeSupabase(), "admin-1", RuntimeError("boom")
            )
            is False
        )
    finally:
        del os.environ["TSCOPIER_ADMIN_USER_IDS"]
