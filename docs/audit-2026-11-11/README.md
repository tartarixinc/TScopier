# Production latency & regression audit — 2026-11-11

Full read-only audit reports produced while investigating the production symptoms
(7–15s entry latency, up to 30s management/closes, duplicate & stale trades,
unstable TP/SL). Condensed findings live in
`docs/scratchpad-latency-audit-2026-11-11.md`.

| Report | Scope |
|---|---|
| [entry-path.md](entry-path.md) | Signal → dispatch → broker order latency (the 7–15s) |
| [management-path.md](management-path.md) | Trade management & close latency (the 30s) |
| [duplicate-stale-protections.md](duplicate-stale-protections.md) | Duplicate/stale trade guard status & bypasses |
| [tp-sl-writes.md](tp-sl-writes.md) | TP/SL writers, conflicts, one-sided-modify coverage |
| [past-fixes-timeline.md](past-fixes-timeline.md) | Timeline of past fixes & which regressed |
| [cleanup-candidates.md](cleanup-candidates.md) | Cleanup/refactor backlog — RECOMMENDATIONS ONLY, nothing applied |
| [code-preservation-regression-checklist.md](code-preservation-regression-checklist.md) | Per-fix guard: code markers + behaviour checks to prove none of Martins's fixes were removed/changed |
| [verify-martins-fixes.sh](verify-martins-fixes.sh) | Executable 46-check code-preservation verifier (run after any merge/revert) |
| [regression-checklist.md](regression-checklist.md) | Deploy/UX regression checklist for his full 2026-11-11 push |
| [pulled-fixes.md](pulled-fixes.md) | Per-commit record of every fix pulled from upstream main/migration (what, why, files, review notes, verification) |

Note: all reports are research output. Only changes explicitly listed in
`PROJECT_MEMORY.md` and the main scratchpad were actually applied.
