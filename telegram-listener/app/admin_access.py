"""Admin access check — mirrors worker/src/subscriptionAccess.loadCachedUserIsAdmin."""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any


def is_admin_access_active(profile: Any) -> bool:
    if not isinstance(profile, dict) or profile.get("is_admin") is not True:
        return False
    until = profile.get("admin_until")
    if until in (None, ""):
        return True
    try:
        parsed = datetime.fromisoformat(str(until).replace("Z", "+00:00"))
    except ValueError:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed > datetime.now(timezone.utc)


def admin_user_ids_from_env() -> set[str]:
    raw = os.getenv("TSCOPIER_ADMIN_USER_IDS", "")
    return {part for part in re.split(r"[,;\s]+", raw.strip()) if part}


def user_is_admin(supabase: Any, user_id: str) -> bool:
    """True when this user may override the one-Telegram-per-account rule.

    Mirrors two of the three signals the TS worker checks: the
    TSCOPIER_ADMIN_USER_IDS environment list and user_profiles.is_admin (with
    its timed expiry). The third — an admin flag stored only in the auth user's
    app_metadata — is deliberately not read from Python: it needs an auth admin
    call this service never makes, and failing closed (blocking the link) is the
    safe direction for a rule that protects account ownership.
    """
    if not user_id:
        return False
    if user_id in admin_user_ids_from_env():
        return True
    try:
        row = (
            supabase.table("user_profiles")
            .select("is_admin, admin_until")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        ).data
    except Exception as exc:
        print(f"[admin_access] profile read failed user={user_id}: {exc}")
        return False
    return is_admin_access_active(row)
