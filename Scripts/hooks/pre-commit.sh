#!/bin/bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

snapshot=$(mktemp -d)
trap 'rm -rf "$snapshot"' EXIT
trap 'exit 1' HUP INT TERM
mkdir "$snapshot/tree"

if git diff --cached --quiet -- .swift-format .swiftlint.yml; then
    git diff --cached --name-only --diff-filter=ACMR -z -- "$@" > "$snapshot/paths"
else
    status=$?
    [ "$status" -eq 1 ] || exit "$status"
    git ls-files -z -- "$@" > "$snapshot/paths"
fi

files=()
while IFS= read -r -d '' path; do
    case "$path" in
        *.swift) files+=("$path") ;;
    esac
done < "$snapshot/paths"

[ "${#files[@]}" -gt 0 ] || exit 0

if ! command -v swift >/dev/null || ! swiftlint_bin=$(mise which swiftlint); then
    printf '%s\n' 'Swift checks require Xcode and the SwiftLint version in mise.toml. Run mise trust and mise install.' >&2
    exit 1
fi

# Export the index that Git supplied for this commit, including staged lint rules.
printf '%s\0' .swift-format .swiftlint.yml "${files[@]}" |
    git checkout-index --stdin -z --prefix="$snapshot/tree/"

cd "$snapshot/tree"
for path in .swift-format .swiftlint.yml "${files[@]}"; do
    if [ ! -f "$path" ] || [ -L "$path" ]; then
        printf 'Expected a staged regular file: %s\n' "$path" >&2
        exit 1
    fi
done

SWIFTLINT_BIN="$swiftlint_bin" bash "$root/Scripts/hooks/check-swift.sh" "${files[@]}"
