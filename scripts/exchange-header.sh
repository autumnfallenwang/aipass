#!/bin/sh
# Prints {"Authorization": "Bearer <pass>"} for Claude Code's `headersHelper`,
# by token exchange (S6). Needs AIPASS_CLIENT_ID and AIPASS_CLIENT_SECRET.
#   ./scripts/exchange-header.sh --agent diabetes-coach
cd "$(dirname "$0")/.." && exec pnpm -s exec tsx scripts/exchange-header.ts "$@"
