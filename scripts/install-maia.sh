#!/usr/bin/env bash
# Installs Maia-3 (human-like move prediction, AGPL-3.0) for the human-like opponent, entirely inside .engines/:
# a private Python virtual environment with the CPU build of PyTorch, the Maia-3 package at a fixed commit, and
# the small 5M model. Nothing is installed system-wide; delete .engines/maia-* and .engines/hf-cache to remove it.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
engines="$root/.engines"
commit=1e13597c42d4858b7cfd7cfdae01e297263364b2
mkdir -p "$engines"
cd "$engines"
[ -d maia-venv ] || python3 -m venv maia-venv
maia-venv/bin/pip install -q --upgrade pip
maia-venv/bin/pip install -q torch --index-url https://download.pytorch.org/whl/cpu
if [ ! -d maia3 ]; then git clone -q https://github.com/CSSLab/maia3.git; fi
git -C maia3 fetch -q --depth 1 origin "$commit" && git -C maia3 checkout -q "$commit"
maia-venv/bin/pip install -q ./maia3
# Download the model once, so the server can run Maia offline.
printf 'uci\nisready\nquit\n' | HF_HOME="$engines/hf-cache" maia-venv/bin/maia3-uci --model maia3-5m --cache-dir "$engines/maia-cache" --device cpu >/dev/null
echo "Maia-3 installed in $engines"
