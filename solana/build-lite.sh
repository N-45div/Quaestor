#!/usr/bin/env bash
# Build the lean governor (programs/quaestor-stocks-lite) and report its rent.
#
#   wsl bash solana/build-lite.sh          # build, print size and rent
#   wsl bash solana/build-lite.sh --test   # ...then run the validator suite against it
#
# It is the same program as programs/quaestor-stocks with the same wire format,
# written against Pinocchio instead of Anchor, because a program's rent is its
# size. It builds into its own target directory: both crates produce
# `quaestor_stocks.so`, and the validator loads whichever directory it is given.
set -euo pipefail

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/node22/bin:$PATH"
HERE="$(cd "$(dirname "$0")" && pwd)"
ANCHOR_TARGET="${ANCHOR_TARGET_DIR:-$HOME/quaestor-target}"
export CARGO_TARGET_DIR="${LITE_TARGET_DIR:-$HOME/quaestor-target-lite}"
REL="$CARGO_TARGET_DIR/sbpf-solana-solana/release"

command -v cargo-build-sbf >/dev/null || { echo "missing cargo-build-sbf — see solana/README.md"; exit 1; }

(cd "$HERE/programs/quaestor-stocks-lite" && cargo build-sbf)

SO="$CARGO_TARGET_DIR/deploy/quaestor_stocks.so"
BYTES=$(stat -c %s "$SO")
# Rent-exempt minimum: 6960 lamports a byte, over the program data (the binary
# plus a 45-byte header) and the 128 bytes every account is charged for.
awk -v b="$BYTES" 'BEGIN { printf "\nlean build   %d bytes   rent %.4f SOL\n", b, (b + 45 + 128) * 6960 / 1e9 }'
if [ -f "$ANCHOR_TARGET/deploy/quaestor_stocks.so" ]; then
  awk -v b="$(stat -c %s "$ANCHOR_TARGET/deploy/quaestor_stocks.so")" 'BEGIN { printf "anchor build %d bytes   rent %.4f SOL\n", b, (b + 45 + 128) * 6960 / 1e9 }'
fi

[ "${1:-}" = "--test" ] || exit 0

# The suite needs the test venue beside the governor, and it must test the
# stripped artifact, since that is the one that would be deployed.
[ -f "$ANCHOR_TARGET/sbpf-solana-solana/release/router_stub.so" ] || { echo "missing router_stub.so — run: wsl bash solana/build.sh"; exit 1; }
cp "$ANCHOR_TARGET/sbpf-solana-solana/release/router_stub.so" "$REL/router_stub.so"
cp "$SO" "$REL/quaestor_stocks.so"

# Matched by exact process name, so this script cannot match itself.
pkill -x solana-test-val 2>/dev/null || true
pkill -x solana-test-validator 2>/dev/null || true
sleep 1
LEDGER="${LEDGER:-$HOME/quaestor-ledger-lite}" setsid nohup bash "$HERE/tests/validator.sh" > "$CARGO_TARGET_DIR/validator.log" 2>&1 < /dev/null &
for _ in $(seq 1 60); do
  solana cluster-version -u http://127.0.0.1:8899 >/dev/null 2>&1 && break
  sleep 1
done
solana cluster-version -u http://127.0.0.1:8899 >/dev/null 2>&1 || { echo "validator did not start"; tail -20 "$CARGO_TARGET_DIR/validator.log"; exit 1; }

STATUS=0
(cd "$HERE/.." && TS_NODE_TRANSPILE_ONLY=1 node node_modules/mocha/bin/mocha.js --require ts-node/register --timeout 120000 'solana/tests/*.test.ts') || STATUS=$?
pkill -x solana-test-val 2>/dev/null || true
pkill -x solana-test-validator 2>/dev/null || true
exit $STATUS
