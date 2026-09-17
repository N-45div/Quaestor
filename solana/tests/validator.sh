#!/usr/bin/env bash
# Start a local validator with both programs already deployed.
#
#   wsl bash solana/tests/validator.sh          # run in the foreground
#   wsl bash solana/tests/validator.sh --stop   # kill a running one
#
# The programs are loaded at their declared ids rather than deployed by a
# transaction: the governor pins its router by address, so the stub has to come
# up at exactly the id `declare_id!` was built with or no trade can be routed.
#
# The ledger is deliberately on the Linux filesystem. Under /mnt/c the validator
# writes through the 9p bridge and misses its slot timing.
set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${CARGO_TARGET_DIR:-$HOME/quaestor-target}"
SO="$TARGET/sbpf-solana-solana/release"
LEDGER="${LEDGER:-$HOME/quaestor-ledger}"

if [ "${1:-}" = "--stop" ]; then
  pkill -f solana-test-validator && echo "stopped" || echo "not running"
  exit 0
fi

command -v solana-test-validator >/dev/null || { echo "missing solana-test-validator — see solana/README.md"; exit 1; }

# Only the [programs.localnet] block; elsewhere Anchor.toml holds urls and
# wallet paths in the same key = "value" shape.
ids() {
  sed -n '/^\[programs\.localnet\]/,/^\[registry\]/{ s/^\([a-z_][a-z_]*\) *= *"\([1-9A-HJ-NP-Za-km-z]\{32,44\}\)".*/\1 \2/p }' "$HERE/../Anchor.toml"
}

args=(--reset --ledger "$LEDGER" --quiet)
while read -r name id; do
  [ -f "$SO/$name.so" ] || { echo "missing $SO/$name.so — run: wsl bash solana/build.sh"; exit 1; }
  args+=(--bpf-program "$id" "$SO/$name.so")
  echo "loading $name at $id"
done < <(ids)

# Token-2022 ships with the validator; xStocks mints use it, so a suite that
# stood up only classic SPL would not be testing the mints this actually trades.
exec solana-test-validator "${args[@]}"
