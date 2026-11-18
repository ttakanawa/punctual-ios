#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
mkdir -p "$temporary/bin" "$temporary/repository with spaces"
repository="$temporary/repository with spaces"
mkdir -p "$repository/ci_scripts"
touch "$repository/Makefile"
cp "$root/ci_scripts/require-main-ci.sh" "$repository/ci_scripts/"
ln -s "$(command -v jq)" "$temporary/bin/jq"
ln -s "$(command -v sh)" "$temporary/bin/sh"

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
for argument do url=$argument; done
case "$url" in
    *"branch=main&event=push&head_sha=$CI_COMMIT&per_page=1") ;;
    *) exit 91 ;;
esac
[ "${API_STATUS:-0}" -eq 0 ] || exit "$API_STATUS"
printf '%s\n' "$API_RESPONSE"
STUB
chmod +x "$temporary"/bin/*

run_hook() {
    PATH="$temporary/bin" CI_XCODE_CLOUD=TRUE CI_START_CONDITION=manual \
        CI_PRIMARY_REPOSITORY_PATH="$repository" CI_XCODEBUILD_ACTION=archive \
        CI_COMMIT=0123456789abcdef0123456789abcdef01234567 \
        EXPECTED_REPOSITORY="$repository" CALLS="$temporary/calls" SETUP_CALLS="$temporary/setup-calls" \
        /usr/bin/env "$@" /bin/sh "$root/ci_scripts/ci_post_clone.sh"
}

run_hook CI_XCODEBUILD_ACTION=build-for-testing CI_PRIMARY_REPOSITORY_PATH=
run_hook CI_XCODEBUILD_ACTION=test-without-building CI_PRIMARY_REPOSITORY_PATH=
[ ! -e "$temporary/calls" ]
[ ! -e "$temporary/setup-calls" ]
if run_hook CI_START_CONDITION=push; then
    echo 'Unexpected success for automatic TestFlight build.' >&2
    exit 1
fi
[ ! -e "$temporary/calls" ]
[ ! -e "$temporary/setup-calls" ]
success='{"workflow_runs":[{"head_sha":"0123456789abcdef0123456789abcdef01234567","head_branch":"main","event":"push","status":"completed","conclusion":"success","html_url":"https://github.com/ttakanawa/punctual-ios/actions/runs/1"}]}'
for result in failure cancelled skipped null; do
    unsuccessful=$(printf '%s\n' "$success" | jq --arg result "$result" '.workflow_runs[0].conclusion = $result')
    if run_hook API_RESPONSE="$unsuccessful"; then
        echo "Unexpected success for CI result $result." >&2
        exit 1
    fi
done
wrong_commit=$(printf '%s\n' "$success" | jq '.workflow_runs[0].head_sha = "aaa"')
in_progress=$(printf '%s\n' "$success" | jq '.workflow_runs[0].status = "in_progress"')
for invalid_response in "$wrong_commit" "$in_progress" '{"workflow_runs":[]}' invalid; do
    if run_hook API_RESPONSE="$invalid_response"; then
        echo 'Accepted an unrelated or incomplete CI result.' >&2
        exit 1
    fi
done
if run_hook API_STATUS=22; then
    echo 'Unexpected success for GitHub API failure.' >&2
    exit 1
fi
[ ! -e "$temporary/calls" ]
: > "$temporary/setup-calls"
status=0
run_hook API_RESPONSE="$success" BREW_STATUS=31 || status=$?
[ "$status" -eq 31 ]
[ "$(cat "$temporary/setup-calls")" = 'install jq' ]
[ ! -e "$temporary/calls" ]
: > "$temporary/setup-calls"
run_hook API_RESPONSE="$success"
[ "$(cat "$temporary/setup-calls")" = 'install jq' ]
[ "$(cat "$temporary/calls")" = validate-testflight ]
status=0
run_hook API_RESPONSE="$success" MAKE_STATUS=33 || status=$?
[ "$status" -eq 33 ]
echo 'Xcode Cloud hook tests passed.'
