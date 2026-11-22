#!/bin/sh
set -eu

sha=${1:-}
case "$sha" in
    ''|*[!0-9a-f]*) echo 'Expected the full Git commit SHA.' >&2; exit 1 ;;
esac
[ "${#sha}" -eq 40 ] || { echo 'Expected the full Git commit SHA.' >&2; exit 1; }

if [ -n "${GITHUB_ACTIONS_READ_TOKEN:-}" ]; then
    set -- --header "Authorization: Bearer $GITHUB_ACTIONS_READ_TOKEN"
else
    set --
fi

url="https://api.github.com/repos/ttakanawa/punctual-ios/actions/workflows/ci.yml/runs"
if ! response=$(curl --disable --fail --silent --show-error \
    --connect-timeout 5 --max-time 15 \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2026-03-10' "$@" \
    "$url?branch=main&event=push&head_sha=$sha&per_page=1"); then
    echo "Could not read CI status for $sha." >&2
    exit 1
fi

if ! run_url=$(printf '%s' "$response" | jq -er --arg sha "$sha" '
    .workflow_runs[0]
    | select(.head_sha == $sha and .head_branch == "main" and .event == "push"
             and .status == "completed" and .conclusion == "success")
    | .html_url | strings | select(length > 0)'); then
    echo "CI must pass on main for $sha before distribution." >&2
    exit 1
fi
printf 'Verified CI for %s: %s\n' "$sha" "$run_url"
