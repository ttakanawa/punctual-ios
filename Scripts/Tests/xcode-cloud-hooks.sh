#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
mkdir -p "$temporary/bin" "$temporary/repository with spaces"
repository="$temporary/repository with spaces"
touch "$repository/Makefile"
git -C "$repository" init -q
git -C "$repository" add Makefile
git -C "$repository" -c user.name=Test -c user.email=test@example.com \
    -c core.hooksPath=/dev/null -c commit.gpgsign=false commit -qm fixture
sha=$(git -C "$repository" rev-parse HEAD)
tag="punctual-testflight-v1-$sha"
ln -s "$(command -v jq)" "$temporary/bin/jq"
ln -s "$(command -v sh)" "$temporary/bin/sh"
ln -s "$(command -v git)" "$temporary/bin/git"

cat > "$temporary/bin/make" <<'STUB'
#!/bin/sh
set -eu
[ "$PWD" = "$EXPECTED_REPOSITORY" ]
[ "$*" = validate-testflight ]
printf '%s\n' "$*" >> "$CALLS"
exit "${MAKE_STATUS:-0}"
STUB
cat > "$temporary/bin/brew" <<'STUB'
#!/bin/sh
set -eu
[ "${HOMEBREW_NO_AUTO_UPDATE:-}" = 1 ]
[ "$*" = 'install jq' ]
printf '%s\n' "$*" >> "$SETUP_CALLS"
exit "${BREW_STATUS:-0}"
STUB
cat > "$temporary/bin/curl" <<'STUB'
#!/bin/sh
set -eu
if [ -n "${ARCHIVE_CURL_CALLS:-}" ]; then
    printf '%s\n' "$*" >> "$ARCHIVE_CURL_CALLS"
    exit 99
fi
branch= event= sha=
for argument do
    case "$argument" in
        branch=*) branch=${argument#branch=} ;;
        event=*) event=${argument#event=} ;;
        head_sha=*) sha=${argument#head_sha=} ;;
    esac
done
[ "$argument" = 'https://api.github.com/repos/ttakanawa/punctual-ios/actions/workflows/ci.yml/runs' ]
[ "$branch" = "$EXPECTED_BRANCH" ] && [ "$event" = "$EXPECTED_EVENT" ] && [ "$sha" = "$CI_COMMIT" ]
[ "${API_STATUS:-0}" -eq 0 ] || exit "$API_STATUS"
printf '%s\n' "$API_RESPONSE"
STUB
chmod +x "$temporary"/bin/*

run_hook() {
    PATH="$temporary/bin" CI_XCODE_CLOUD=TRUE CI_START_CONDITION=manual \
        CI_PRIMARY_REPOSITORY_PATH="$repository" CI_XCODEBUILD_ACTION=archive \
        CI_COMMIT="$sha" CI_GIT_REF="refs/tags/$tag" CI_TAG="$tag" \
        ARCHIVE_CURL_CALLS="$temporary/archive-curl-calls" \
        EXPECTED_REPOSITORY="$repository" CALLS="$temporary/calls" SETUP_CALLS="$temporary/setup-calls" \
        /usr/bin/env "$@" /bin/sh "$root/ci_scripts/ci_post_clone.sh"
}

run_ci() (
    branch=$1
    event=$2
    shift 2
    PATH="$temporary/bin" CI_COMMIT="$sha" EXPECTED_BRANCH="$branch" EXPECTED_EVENT="$event" \
        GITHUB_ACTIONS_READ_TOKEN='' /usr/bin/env "$@" /bin/sh "$root/ci_scripts/require-ci.sh" "$branch" "$sha"
)

run_hook CI_XCODEBUILD_ACTION=build-for-testing CI_PRIMARY_REPOSITORY_PATH=
run_hook CI_XCODEBUILD_ACTION=test-without-building CI_PRIMARY_REPOSITORY_PATH=
[ ! -e "$temporary/calls" ]
[ ! -e "$temporary/setup-calls" ]
if run_hook CI_START_CONDITION=push || run_hook CI_START_CONDITION=manual_rebuild; then
    echo 'Accepted an automatic start or Apple rebuild.' >&2
    exit 1
fi
[ ! -e "$temporary/calls" ]
[ ! -e "$temporary/setup-calls" ]
success=$(jq -nc --arg sha "$sha" '{workflow_runs:[{
    head_sha:$sha, head_branch:"main", event:"push", status:"completed", conclusion:"success",
    head_repository:{full_name:"ttakanawa/punctual-ios"},
    html_url:"https://github.com/ttakanawa/punctual-ios/actions/runs/1"
}]}')
for result in failure cancelled skipped null; do
    unsuccessful=$(printf '%s\n' "$success" | jq --arg result "$result" '.workflow_runs[0].conclusion = $result')
    if run_ci main push API_RESPONSE="$unsuccessful"; then
        echo "Unexpected success for CI result $result." >&2
        exit 1
    fi
done
wrong_commit=$(printf '%s\n' "$success" | jq '.workflow_runs[0].head_sha = "aaa"')
in_progress=$(printf '%s\n' "$success" | jq '.workflow_runs[0].status = "in_progress"')
pr_run=$(printf '%s\n' "$success" | jq '.workflow_runs[0].event = "pull_request"')
manual_main=$(printf '%s\n' "$success" | jq '.workflow_runs[0].event = "workflow_dispatch"')
fork_run=$(printf '%s\n' "$success" | jq '.workflow_runs[0].head_repository.full_name = "fork/punctual-ios"')
for invalid_response in "$wrong_commit" "$in_progress" "$pr_run" "$manual_main" "$fork_run" '{"workflow_runs":[]}' invalid; do
    if run_ci main push API_RESPONSE="$invalid_response"; then
        echo 'Accepted an unrelated or incomplete CI result.' >&2
        exit 1
    fi
done
if run_ci main push API_STATUS=22; then
    echo 'Unexpected success for GitHub API failure.' >&2
    exit 1
fi
if run_hook CI_COMMIT=0123456789abcdef0123456789abcdef01234567 ||
    run_hook CI_GIT_REF=refs/heads/feature/reminders CI_TAG= ||
    run_hook CI_GIT_REF="refs/heads/$tag" ||
    run_hook CI_GIT_REF=refs/tags/main CI_TAG=main ||
    run_hook CI_GIT_REF=refs/tags/punctual-testflight-v1-garbage CI_TAG=punctual-testflight-v1-garbage ||
    run_hook CI_GIT_REF= || run_hook CI_TAG=; then
    echo 'Accepted a non-deployment ref or inconsistent Xcode Cloud metadata.' >&2
    exit 1
fi
[ ! -e "$temporary/calls" ]
: > "$temporary/setup-calls"
status=0
run_hook BREW_STATUS=31 || status=$?
[ "$status" -eq 31 ]
[ "$(cat "$temporary/setup-calls")" = 'install jq' ]
[ ! -e "$temporary/calls" ]
: > "$temporary/setup-calls"
run_hook
[ "$(cat "$temporary/setup-calls")" = 'install jq' ]
[ "$(cat "$temporary/calls")" = validate-testflight ]
branch=feature/reminders
branch_success=$(printf '%s\n' "$success" | jq --arg branch "$branch" \
    '.workflow_runs[0] |= (.head_branch = $branch | .event = "workflow_dispatch")')
run_ci main push API_RESPONSE="$success"
run_ci "$branch" workflow_dispatch API_RESPONSE="$branch_success"
if run_ci "$branch" workflow_dispatch API_RESPONSE="$success"; then
    echo 'Accepted main CI for a different branch.' >&2
    exit 1
fi

# Issued tags can start in Apple even when newer GitHub CI blocks new issuance.
latest_failure=$(printf '%s\n' "$branch_success" | jq '
    .workflow_runs |= [(.[0] | .conclusion = "failure"), .[0]]')
if run_ci "$branch" workflow_dispatch API_RESPONSE="$latest_failure"; then
    echo 'Issued a tag despite a newer failing run for the same branch and SHA.' >&2
    exit 1
fi
: > "$temporary/calls"
run_hook CI_BRANCH='' API_RESPONSE="$latest_failure"
run_hook CI_BRANCH='' API_STATUS=22
[ "$(cat "$temporary/calls")" = "$(printf '%s\n' validate-testflight validate-testflight)" ]
[ ! -e "$temporary/archive-curl-calls" ]

# A different checkout can have passing CI and still must fail the archive gate.
git -C "$repository" -c user.name=Test -c user.email=test@example.com \
    -c core.hooksPath=/dev/null -c commit.gpgsign=false commit --allow-empty -qm 'new branch head'
sha=$(git -C "$repository" rev-parse HEAD)
if run_ci "$branch" workflow_dispatch API_RESPONSE="$branch_success"; then
    echo 'Accepted CI for the previous branch head.' >&2
    exit 1
fi
new_success=$(printf '%s\n' "$branch_success" | jq --arg sha "$sha" '.workflow_runs[0].head_sha = $sha')
run_ci "$branch" workflow_dispatch API_RESPONSE="$new_success"
: > "$temporary/calls"
: > "$temporary/setup-calls"
if run_hook; then
    echo 'Archived a different checkout with passing CI under the original deployment tag.' >&2
    exit 1
fi
[ ! -s "$temporary/calls" ]
[ ! -s "$temporary/setup-calls" ]
tag="punctual-testflight-v1-$sha"
status=0
run_hook MAKE_STATUS=33 || status=$?
[ "$status" -eq 33 ]
echo 'Xcode Cloud hook tests passed.'
