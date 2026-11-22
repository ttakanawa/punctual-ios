#!/bin/sh
set -eu

branch=${1:-}
sha=${2:-}
git check-ref-format "refs/heads/$branch" || { echo 'Expected a Git branch name.' >&2; exit 1; }
case "$sha" in
    ''|*[!0-9a-f]*) echo 'Expected the full Git commit SHA.' >&2; exit 1 ;;
esac
[ "${#sha}" -eq 40 ] || { echo 'Expected the full Git commit SHA.' >&2; exit 1; }

if [ -n "${GITHUB_ACTIONS_READ_TOKEN:-}" ]; then
    set -- --header "Authorization: Bearer $GITHUB_ACTIONS_READ_TOKEN"
else
    set --
fi

event=workflow_dispatch
[ "$branch" != main ] || event=push
repository=ttakanawa/punctual-ios
url="https://api.github.com/repos/$repository/actions/workflows/ci.yml/runs"
if ! response=$(curl --disable --fail --silent --show-error --get \
    --connect-timeout 5 --max-time 15 \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2026-03-10' "$@" \
    --data-urlencode "branch=$branch" --data-urlencode "event=$event" \
    --data-urlencode "head_sha=$sha" --data-urlencode per_page=1 "$url"); then
    echo "Could not read CI status for $sha." >&2
    exit 1
fi

if ! run_url=$(printf '%s' "$response" | jq -er --arg sha "$sha" \
    --arg branch "$branch" --arg event "$event" --arg repository "$repository" '
    .workflow_runs[0]
    | select(.head_sha == $sha and .head_branch == $branch and .event == $event
             and .head_repository.full_name == $repository
             and .status == "completed" and .conclusion == "success")
    | .html_url | strings | select(length > 0)'); then
    echo "CI ($event) must pass on $branch at $sha before distribution." >&2
    exit 1
fi
printf 'Verified CI on %s at %s: %s\n' "$branch" "$sha" "$run_url"
