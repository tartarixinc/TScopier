"""Plain-assert tests for the sealed-session guard (runnable without pytest):

    python3 tests/test_session_guard.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.session_guard import session_value_or_refuse  # noqa: E402


def test_plaintext_passthrough():
    assert session_value_or_refuse("u1", "1A2B3C") == "1A2B3C"


def test_empty_values_stay_empty():
    assert session_value_or_refuse("u1", "") == ""
    assert session_value_or_refuse("u1", None) == ""


def test_sealed_value_is_refused_not_returned():
    assert session_value_or_refuse("u1", "v1:abc123:def456") is None


def test_non_string_values_are_stringified():
    assert session_value_or_refuse("u1", 123) == "123"


if __name__ == "__main__":
    test_plaintext_passthrough()
    test_empty_values_stay_empty()
    test_sealed_value_is_refused_not_returned()
    test_non_string_values_are_stringified()
    print("test_session_guard: 4 passed")
