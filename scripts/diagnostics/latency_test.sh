#!/usr/bin/env bash
# Production pipeline latency regression test (trade_execution_logs pipeline_summary).
#
# Usage:
#   ./scripts/diagnostics/latency_test.sh
#
# Optional env (passed through to worker report):
#   LATENCY_CURRENT_HOURS=6    # default 6
#   LATENCY_BASELINE_DAYS=7      # default 7
#   LATENCY_REGRESSION_PCT=25    # flag regression when p50/p95 total_ms rises more than this %
#
# Requires worker/.env with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/worker"

if [[ ! -f .env ]]; then
  echo "error: worker/.env not found (need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)" >&2
  exit 2
fi

export LATENCY_CURRENT_HOURS="${LATENCY_CURRENT_HOURS:-6}"
export LATENCY_BASELINE_DAYS="${LATENCY_BASELINE_DAYS:-7}"
export LATENCY_REGRESSION_PCT="${LATENCY_REGRESSION_PCT:-25}"

echo "=== Pipeline latency test (production logs) ==="
echo "Current window:  last ${LATENCY_CURRENT_HOURS}h"
echo "Baseline window: prior ${LATENCY_BASELINE_DAYS}d (excluding current)"
echo

npm run latency-report
code=$?

echo
echo "For SQL drill-down, run scripts/diagnostics/pipeline_latency_regression.sql in Supabase SQL Editor."
exit $code
