#!/usr/bin/env bash
# Build the Quaestor Solana programs.
#
#   wsl bash solana/build.sh            # compile both programs to SBF
#   wsl bash solana/build.sh --ids      # print program ids and exit
#
# Anchor does not run on native Windows, so this is written to be invoked from
# WSL. The Rust target directory is deliberately kept on the Linux filesystem:
# building under /mnt/c goes through the 9p bridge and is many times slower.
#
# Program keypairs live alongside the build output rather than in the repo. They
# are deploy authorities, not source.
set -euo pipefail

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
HERE="$(cd "$(dirname "$0")" && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/quaestor-target}"
DEPLOY="$CARGO_TARGET_DIR/deploy"
mkdir -p "$DEPLOY"

for tool in cargo solana-keygen cargo-build-sbf; do
  command -v "$tool" >/dev/null || { echo "missing $tool — see solana/README.md"; exit 1; }
done

declare -A SRC=(
  [quaestor_stocks]="$HERE/programs/quaestor-stocks/src/lib.rs"
  [router_stub]="$HERE/programs/router-stub/src/lib.rs"
)

for program in "${!SRC[@]}"; do
  key="$DEPLOY/$program-keypair.json"
  [ -f "$key" ] || solana-keygen new --no-bip39-passphrase --silent -o "$key"
  id="$(solana-keygen pubkey "$key")"
  # Keep declare_id! in step with the keypair that will actually deploy it; a
  # mismatch only surfaces at deploy time, as a DeclaredProgramIdMismatch.
  sed -i -E "s/^declare_id!\(\"[^\"]+\"\);/declare_id!(\"$id\");/" "${SRC[$program]}"
  sed -i -E "s/^($program = )\"[^\"]+\"/\1\"$id\"/" "$HERE/Anchor.toml" 2>/dev/null || true
  echo "$program = $id"
done

[ "${1:-}" = "--ids" ] && exit 0

cd "$HERE"
cargo build-sbf
echo
ls -la "$CARGO_TARGET_DIR"/sbpf*/release/*.so 2>/dev/null || ls -la "$DEPLOY"/*.so 2>/dev/null || true
