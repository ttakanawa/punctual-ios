#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
mkdir -p "$temporary/bin" "$temporary/repository with spaces"
repository="$temporary/repository with spaces"
mkdir -p "$repository/ci_scripts"
cp "$root/ci_scripts/require-ci.sh" "$repository/ci_scripts/"
touch "$repository/Makefile"
git -C "$repository" init -q
git -C "$repository" add Makefile ci_scripts/require-ci.sh
git -C "$repository" -c user.name=Test -c user.email=test@example.com \
    -c core.hooksPath=/dev/null -c commit.gpgsign=false commit -qm fixture
sha=$(git -C "$repository" rev-parse HEAD)
source_run=45030258445
tag="punctual-testflight-v2-$sha-$source_run"
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
branch= event= sha= per_page= cache_control=
for argument do
    case "$argument" in
        branch=*) branch=${argument#branch=} ;;
        event=*) event=${argument#event=} ;;
        head_sha=*) sha=${argument#head_sha=} ;;
        per_page=*) per_page=${argument#per_page=} ;;
        'Cache-Control: no-cache') cache_control=present ;;
    esac
done
[ "$cache_control" = present ]
case "$argument" in
    "https://api.github.com/repos/ttakanawa/punctual-ios/actions/runs/${EXPECTED_SOURCE_RUN:-}")
        printf '%s\n' "origin:$EXPECTED_SOURCE_RUN" >> "$QUERY_LOG"
        [ "${ORIGIN_STATUS:-0}" -eq 0 ] || exit "$ORIGIN_STATUS"
        printf '%s\n' "$ORIGIN_RESPONSE"
        ;;
    'https://api.github.com/repos/ttakanawa/punctual-ios/actions/workflows/ci.yml/runs')
        [ "$branch" = "$EXPECTED_BRANCH" ] && [ "$event" = "$EXPECTED_EVENT" ] &&
            [ "$sha" = "$CI_COMMIT" ] && [ "$per_page" = 1 ] || exit 1
        printf '%s\n' "latest:$branch:$event:$sha" >> "$QUERY_LOG"
        [ "${API_STATUS:-0}" -eq 0 ] || exit "$API_STATUS"
        printf '%s\n' "$API_RESPONSE"
        ;;
    *) exit 1 ;;
esac
STUB
chmod +x "$temporary"/bin/*

run_hook() {
    PATH="$temporary/bin" CI_XCODE_CLOUD=TRUE CI_START_CONDITION=manual \
        CI_PRIMARY_REPOSITORY_PATH="$repository" CI_XCODEBUILD_ACTION=archive \
        CI_COMMIT="$sha" CI_GIT_REF="refs/tags/$tag" CI_TAG="$tag" CI_BRANCH='' \
        GITHUB_ACTIONS_READ_TOKEN='' QUERY_LOG="$temporary/queries" \
        EXPECTED_BRANCH=main EXPECTED_EVENT=push EXPECTED_SOURCE_RUN="$source_run" \
        EXPECTED_REPOSITORY="$repository" CALLS="$temporary/calls" SETUP_CALLS="$temporary/setup-calls" \
        /usr/bin/env "$@" /bin/sh "$root/ci_scripts/ci_post_clone.sh"
}

run_ci() (
    branch=$1
    event=$2
    shift 2
    PATH="$temporary/bin" CI_COMMIT="$sha" EXPECTED_BRANCH="$branch" EXPECTED_EVENT="$event" \
        GITHUB_ACTIONS_READ_TOKEN='' QUERY_LOG="$temporary/queries" \
        /usr/bin/env "$@" /bin/sh "$root/ci_scripts/require-ci.sh" "$branch" "$sha"
)

expect_archive_blocked() {
    : > "$temporary/calls"
    if run_hook "$@"; then
        echo 'TestFlight archive unexpectedly passed.' >&2
        exit 1
    fi
    [ ! -s "$temporary/calls" ]
}

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
success=$(jq -nc --arg sha "$sha" --argjson id "$source_run" '{workflow_runs:[{
    id:$id, path:".github/workflows/ci.yml", repository:{full_name:"ttakanawa/punctual-ios"},
    head_sha:$sha, head_branch:"main", event:"push", status:"completed", conclusion:"success",
    head_repository:{full_name:"ttakanawa/punctual-ios"}
}]}')
main_origin=$(printf '%s\n' "$success" | jq -c '.workflow_runs[0]')
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
    run_hook CI_GIT_REF="refs/tags/punctual-testflight-v1-$sha" CI_TAG="punctual-testflight-v1-$sha" ||
    run_hook CI_GIT_REF=refs/tags/punctual-testflight-v2-garbage-1 CI_TAG=punctual-testflight-v2-garbage-1 ||
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
run_hook ORIGIN_RESPONSE="$main_origin" API_RESPONSE="$success"
[ "$(cat "$temporary/setup-calls")" = 'install jq' ]
[ "$(cat "$temporary/calls")" = validate-testflight ]
branch=feature/reminders
source_run=45043705986
tag="punctual-testflight-v2-$sha-$source_run"
branch_success=$(printf '%s\n' "$success" | jq --arg branch "$branch" --argjson id "$source_run" \
    '.workflow_runs[0] |= (.id = $id | .head_branch = $branch | .event = "workflow_dispatch")')
branch_origin=$(printf '%s\n' "$branch_success" | jq -c '.workflow_runs[0]')
run_ci main push API_RESPONSE="$success"
run_ci "$branch" workflow_dispatch API_RESPONSE="$branch_success"
if run_ci "$branch" workflow_dispatch API_RESPONSE="$success"; then
    echo 'Accepted main CI for a different branch.' >&2
    exit 1
fi

# A different checkout can have passing CI and still must fail the archive gate.
tagged_sha=$sha
git -C "$repository" branch "$branch" "$tagged_sha"
git -C "$repository" -c user.name=Test -c user.email=test@example.com \
    -c core.hooksPath=/dev/null -c commit.gpgsign=false commit --allow-empty -qm 'new branch head'
sha=$(git -C "$repository" rev-parse HEAD)
git -C "$repository" branch -f "$branch" "$sha"
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
# Model Apple's detached tagged checkout after the source branch has advanced.
git -C "$repository" checkout --detach -q "$tagged_sha"
[ "$(git -C "$repository" rev-parse "refs/heads/$branch")" = "$sha" ]
sha=$tagged_sha
: > "$temporary/queries"
run_branch_archive() {
    run_hook EXPECTED_BRANCH="$branch" EXPECTED_EVENT=workflow_dispatch ORIGIN_RESPONSE="$branch_origin" "$@"
}

# The original run is still green, but newer runs for its exact branch and SHA decide.
newer_run=$(printf '%s\n' "$branch_success" | jq -c '.workflow_runs[0].id += 1')
run_branch_archive API_RESPONSE="$newer_run" CI_BRANCH=main
expected_queries=$(printf 'origin:%s\nlatest:%s:workflow_dispatch:%s' "$source_run" "$branch" "$sha")
[ "$(cat "$temporary/queries")" = "$expected_queries" ]
[ "$(cat "$temporary/calls")" = validate-testflight ]

for result in failure in_progress queued; do
    latest=$(printf '%s\n' "$branch_success" | jq --arg result "$result" '
        .workflow_runs |= [(
            .[0] | .id += 1
            | if $result == "failure" then .conclusion = $result
              else .status = $result | .conclusion = null end
        ), .[0]]')
    : > "$temporary/calls"
    if run_branch_archive API_RESPONSE="$latest"; then
        echo "Accepted an older success in place of the latest CI result ($result)." >&2
        exit 1
    fi
    [ ! -s "$temporary/calls" ]
done

expect_archive_blocked EXPECTED_BRANCH="$branch" EXPECTED_EVENT=workflow_dispatch \
    ORIGIN_RESPONSE="$branch_origin" API_RESPONSE='{"workflow_runs":[]}'
expect_archive_blocked EXPECTED_BRANCH="$branch" EXPECTED_EVENT=workflow_dispatch \
    ORIGIN_RESPONSE="$branch_origin" API_STATUS=22
expect_archive_blocked ORIGIN_STATUS=22
for mutation in '.id += 1' '.head_sha = "aaa"' '.path = ".github/workflows/other.yml"' \
    '.event = "pull_request"' '.head_branch = ""' '.head_branch += "\n"' \
    '.head_repository.full_name = "fork/punctual-ios"' '.repository.full_name = "fork/punctual-ios"'; do
    wrong_origin=$(printf '%s\n' "$branch_origin" | jq "$mutation")
    : > "$temporary/queries"
    expect_archive_blocked ORIGIN_RESPONSE="$wrong_origin" API_RESPONSE="$branch_success"
    [ "$(cat "$temporary/queries")" = "origin:$source_run" ]
done

status=0
run_branch_archive API_RESPONSE="$branch_success" MAKE_STATUS=33 || status=$?
[ "$status" -eq 33 ]
echo 'Xcode Cloud hook tests passed.'
