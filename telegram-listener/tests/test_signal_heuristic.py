"""Tests for signal_heuristic — aligned with worker looksLikeTradingSignal."""

from app.signal_heuristic import looks_like_trading_signal


def test_standard_market_entry():
    assert looks_like_trading_signal("BUY XAUUSD NOW SL 2650 TP 2700")


def test_setup_without_buy_sell_but_entry_and_symbol():
    assert looks_like_trading_signal("Signal setup XAUUSD entry 2650 SL 2640")


def test_rejects_chat():
    assert not looks_like_trading_signal("Good morning traders, weekly outlook ahead.")


def test_reply_management():
    assert looks_like_trading_signal("Move SL to breakeven", is_reply=True)


def test_move_stop_breakeven_without_reply():
    assert looks_like_trading_signal("+50 pips running, you can move stop to breakeven.")


def test_partial_close_secure_profits():
    assert looks_like_trading_signal(
        "Make sure to secure 30% profits by closing partial lotsize"
    )


def test_rejects_prose_close_to():
    assert not looks_like_trading_signal(
        "receive it before price is even close to our entry"
    )


def test_explicit_close_all():
    assert looks_like_trading_signal("Close all now")


def test_spanish_channel_aliases():
    assert looks_like_trading_signal(
        "COMPRA XAUUSD @ 2650 SL 2640 TP 2670",
        channel_aliases=["COMPRA", "VENTA", "SL", "TP"],
    )


def test_training_candidate_instrument_price():
    from app.signal_heuristic import looks_like_training_candidate

    assert looks_like_training_candidate("XAUUSD 2650 2640 2670")
