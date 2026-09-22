#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"
cargo build --workspace
NETA_RMUX_E2E=1 bun test test/rmux-e2e.test.ts
