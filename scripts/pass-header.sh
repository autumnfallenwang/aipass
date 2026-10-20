#!/bin/sh
# Prints {"Authorization": "Bearer <pass>"} for Claude Code's `headersHelper`.
#   ./scripts/pass-header.sh --agent diabetes-coach --person maria
cd "$(dirname "$0")/.." && exec pnpm -s pass --header "$@"
