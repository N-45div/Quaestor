#!/usr/bin/env bash
# Start the hub on a free port, run a command against it, then stop it.
#
#   scripts/hub-run.sh npx ts-node scripts/pay-hedera.ts
#
# `npx` forks a child that survives killing the wrapper, so a previous run can
# leave a stale listener holding the port and serving stale env — which silently
# answers your requests with the old config. This kills by port before and after.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8402}"

free_port() {
  # Windows: find the PID listening on $PORT and kill it. No-op elsewhere.
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "
      Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue }
    " >/dev/null 2>&1
  else
    command -v lsof >/dev/null 2>&1 && lsof -ti tcp:"$PORT" | xargs -r kill -9 2>/dev/null
  fi
  sleep 1
}

free_port
export TS_NODE_TRANSPILE_ONLY=1 PORT
npx ts-node services/main.ts > /tmp/hub.log 2>&1 &
WRAPPER=$!

n=0
until curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 || [ $n -ge 90 ]; do
  sleep 1; n=$((n+1))
  if ! kill -0 $WRAPPER 2>/dev/null && ! curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
    echo "hub died during startup:"; tail -20 /tmp/hub.log; exit 1
  fi
done
if ! curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
  echo "hub never became healthy after ${n}s:"; tail -20 /tmp/hub.log; free_port; exit 1
fi

# Confirm the listener is the one we just started, with the env we just set.
echo "--- hub ready in ${n}s ---"
grep -E "^\[hedera\]|^\[hub\]|^\[budget-root\]" /tmp/hub.log | head -6
echo

"$@"
STATUS=$?

echo
echo "--- hub log (tail) ---"
tail -15 /tmp/hub.log
kill $WRAPPER 2>/dev/null
free_port
exit $STATUS
