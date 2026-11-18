#!/bin/sh

set -eu

fail() {
    echo "Xcode Cloud configuration error: $1" >&2
    exit 1
}

[ "${CI_XCODE_CLOUD:-}" = "TRUE" ] || fail "run local checks with make lint and make test"

case "${CI_START_CONDITION:-}" in
    manual|manual_rebuild) ;;
    *) fail "TestFlight distribution must be started manually for a selected branch" ;;
esac

# Distribution configuration is checked only for an archive. Older workflows
# may still have a Test action while validation moves to GitHub Actions.
[ "${CI_XCODEBUILD_ACTION:-}" = archive ] || exit 0

[ -n "${CI_PRIMARY_REPOSITORY_PATH:-}" ] || fail "CI_PRIMARY_REPOSITORY_PATH is missing"
cd "$CI_PRIMARY_REPOSITORY_PATH"
[ -f Makefile ] || fail "the primary repository must contain Makefile"

# Prepare the archive environment before running the distribution checks.
HOMEBREW_NO_AUTO_UPDATE=1 brew install jq

sh ci_scripts/require-main-ci.sh "${CI_COMMIT:-}"
make validate-testflight
