-- Store range-entry tolerance as numeric so fractional values persist.
--
-- `signal_entry_pip_tolerance` is a user setting written straight into
-- `tolerance_pips`. The settings UI uses `step="any"` and the worker applies
-- `Number()` with no rounding, so a fractional value (observed in production:
-- 0.061 on one channel config, and rejected with
-- `invalid input syntax for type integer` in worker logs) reaches this column.
-- The integer type rejected it, the upsert failed, and the range wait row was
-- never saved — so the wake monitor could not fire the entry. `numeric` accepts
-- both integer and fractional tolerances; existing integer values convert
-- unchanged. Nothing else in the schema reads this column.

ALTER TABLE public.signal_range_entry_waits
  ALTER COLUMN tolerance_pips TYPE numeric
  USING tolerance_pips::numeric;
