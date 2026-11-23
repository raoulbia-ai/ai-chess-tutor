#!/usr/bin/env bash
# Builds Stockfish 15.1, the last release with the classical evaluation, for its `eval` breakdown
# (mobility, king safety, pawns, threats, passed pawns, space). It runs as a separate process next to
# the main engine and is only asked for that breakdown. Output: .engines/stockfish-15.1 (not in git).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$root/.engines/build"
mkdir -p "$work"
cd "$work"
[ -d Stockfish-sf_15.1 ] || curl -fsSL https://github.com/official-stockfish/Stockfish/archive/refs/tags/sf_15.1.tar.gz | tar xz
cd Stockfish-sf_15.1/src
case "$(uname -m)" in
  aarch64|arm64) arch=armv8 ;;
  x86_64) arch=x86-64-modern ;;
  *) arch=general-64 ;;
esac
make -j"$(nproc)" build ARCH="$arch" >/dev/null
cp stockfish "$root/.engines/stockfish-15.1"
echo "Built $root/.engines/stockfish-15.1 ($arch)"
