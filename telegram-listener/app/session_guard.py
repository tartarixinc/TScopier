"""Guard against sealed (encrypted) Telegram session strings.

Dependency-free so it can be unit-tested without telethon/supabase installed.
"""

from __future__ import annotations

from typing import Any


def session_value_or_refuse(user_id: str, value: Any) -> str | None:
    """Return a plaintext session string, or None when the row is sealed.

    The worker encrypts session_string with the shared `v1:` AES envelope when
    TELEGRAM_SESSION_ENCRYPTION_KEY is set. This listener has no key: feeding
    ciphertext to StringSession would produce a garbled login loop — the exact
    class of Telegram incident we must never repeat. Skip loudly instead.
    """
    text = str(value or "")
    if text.startswith("v1:"):
        print(
            f"[session_guard] session user={user_id} is encrypted (v1 envelope) "
            "but this listener has no decryption key — skipping instead of connecting with ciphertext"
        )
        return None
    return text
