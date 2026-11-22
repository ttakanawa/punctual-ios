#!/bin/sh

set -eu

fail() {
    echo "Xcode Cloud configuration error: $1" >&2
    exit 1
}

[ "${CI_XCODE_CLOUD:-}" = "TRUE" ] || fail "run local checks with make lint and make test"

# Distribution configuration is checked only for an archive. Older workflows
# may still have a Test action while validation moves to GitHub Actions.
[ "${CI_XCODEBUILD_ACTION:-}" = archive ] || exit 0

[ "${CI_START_CONDITION:-}" = manual ] || fail "TestFlight requires a manual deployment-tag build"
[ -n "${CI_PRIMARY_REPOSITORY_PATH:-}" ] || fail "CI_PRIMARY_REPOSITORY_PATH is missing"
cd "$CI_PRIMARY_REPOSITORY_PATH"
[ -f Makefile ] || fail "the primary repository must contain Makefile"

case "${CI_GIT_REF:-}" in
    refs/tags/punctual-testflight-v1-*) expected_sha=${CI_GIT_REF#refs/tags/punctual-testflight-v1-} ;;
    *) fail "TestFlight requires a protected deployment tag" ;;
esac
case "$expected_sha" in
    ''|*[!0-9a-f]*) fail "the deployment tag must contain a full commit SHA" ;;
esac
[ "${#expected_sha}" -eq 40 ] || fail "the deployment tag must contain a full commit SHA"
[ "${CI_TAG:-}" = "${CI_GIT_REF#refs/tags/}" ] || fail "CI_TAG does not match the deployment ref"

sha=$(git rev-parse --verify HEAD)
[ "$sha" = "$expected_sha" ] || fail "the checked-out commit does not match the deployment tag"
[ "$sha" = "${CI_COMMIT:-}" ] || fail "the checked-out commit does not match CI_COMMIT"

HOMEBREW_NO_AUTO_UPDATE=1 brew install jq
make validate-testflight
