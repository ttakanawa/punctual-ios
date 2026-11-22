#!/bin/sh
set -eu

branch=${1:-}
sha=${2:-}
mode=${3:-}
case "$sha" in
    ''|*[!0-9a-f]*) echo 'Expected the full Git commit SHA.' >&2; exit 1 ;;
esac
[ "${#sha}" -eq 40 ] || { echo 'Expected the full Git commit SHA.' >&2; exit 1; }

repository=ttakanawa/punctual-ios
api="https://api.github.com/repos/$repository/actions"

github() {
    if [ -n "${GITHUB_ACTIONS_READ_TOKEN:-}" ]; then
        set -- --header "Authorization: Bearer $GITHUB_ACTIONS_READ_TOKEN" "$@"
    fi
    curl --disable --fail --silent --show-error --get \
        --connect-timeout 5 --max-time 15 \
        --header 'Accept: application/vnd.github+json' \
        --header 'Cache-Control: no-cache' \
        --header 'X-GitHub-Api-Version: 2026-03-10' "$@"
}

if [ "$mode" = --from-run ]; then
    source_run=$branch
    case "$source_run" in
        ''|0*|*[!0-9]*) echo 'Expected the CI run ID in the deployment tag.' >&2; exit 1 ;;
    esac
    if ! origin=$(github "$api/runs/$source_run"); then
        echo "Could not read source CI run $source_run." >&2
        exit 1
    fi
    # The issuing run records the original branch even after that branch moves.
    if ! branch=$(printf '%s' "$origin" | jq -er --arg id "$source_run" --arg sha "$sha" --arg repository "$repository" '
        select((.id | tostring) == $id and .head_sha == $sha and .path == ".github/workflows/ci.yml"
               and .repository.full_name == $repository and .head_repository.full_name == $repository
               and .event == (if .head_branch == "main" then "push" else "workflow_dispatch" end))
        | .head_branch | strings | select(length > 0 and (test("[[:cntrl:]]") | not))'); then
        echo "Source CI run $source_run does not identify an eligible branch at $sha." >&2
        exit 1
    fi
fi

git check-ref-format "refs/heads/$branch" || { echo 'Expected a Git branch name.' >&2; exit 1; }
event=workflow_dispatch
[ "$branch" != main ] || event=push
if ! response=$(github --data-urlencode "branch=$branch" --data-urlencode "event=$event" \
    --data-urlencode "head_sha=$sha" --data-urlencode per_page=1 "$api/workflows/ci.yml/runs"); then
    echo "Could not read CI status for $sha." >&2
    exit 1
fi

if ! run_id=$(printf '%s' "$response" | jq -er --arg sha "$sha" \
    --arg branch "$branch" --arg event "$event" --arg repository "$repository" '
    .workflow_runs[0]
    | select(.head_sha == $sha and .head_branch == $branch and .event == $event
             and .path == ".github/workflows/ci.yml"
             and .repository.full_name == $repository and .head_repository.full_name == $repository
             and .status == "completed" and .conclusion == "success")
    | .id | numbers | tostring | select(test("^[1-9][0-9]*$"))'); then
    echo "CI ($event) must pass on $branch at $sha before distribution." >&2
    exit 1
fi
printf 'Verified CI on %s at %s: https://github.com/%s/actions/runs/%s\n' "$branch" "$sha" "$repository" "$run_id" >&2
if [ "$mode" = --print-run-id ]; then
    printf '%s\n' "$run_id"
fi
