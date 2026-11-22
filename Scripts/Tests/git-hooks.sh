#!/bin/bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
# Git exports its own repository/index variables when make is invoked by a hook.
while IFS= read -r variable; do
    unset "$variable"
done < <(git rev-parse --local-env-vars)

fixture="$temporary/repo with spaces"
mkdir -p "$fixture/NotificationManager" "$fixture/.githooks" "$fixture/Scripts/hooks" "$temporary/bin"
cp "$root/Makefile" "$fixture/"
cp "$root/.githooks/pre-commit" "$fixture/.githooks/"
cp "$root"/Scripts/hooks/*.sh "$fixture/Scripts/hooks/"
cd "$fixture"
git init -q
git config user.name 'Hook Test'
git config user.email 'hook-test@example.invalid'
git config core.hooksPath "$temporary/unused-hooks"

cat > "$temporary/bin/mise" <<'STUB'
#!/bin/sh
set -eu
[ "$*" = 'which swiftlint' ]
[ "${MISSING_SWIFTLINT:-0}" -eq 0 ]
printf '%s\n' "$MOCK_BIN/swiftlint"
STUB
cat > "$temporary/bin/swift" <<'STUB'
#!/bin/sh
set -eu
[ "$*" != '' ]
[ "$1" = format ] && [ "$2" = lint ] && [ "$3" = --configuration ]
[ "$(cat "$4")" = "${EXPECTED_FORMAT:-staged-format}" ]
shift 6
printf '%s\n' "$@" >> "$CHECK_LOG"
for path do
    if [ "$(cat "$path")" = BAD_FORMAT ]; then exit 11; fi
done
STUB
cat > "$temporary/bin/swiftlint" <<'STUB'
#!/bin/sh
set -eu
[ "$1" = lint ] && [ "$2" = --config ]
[ "$(cat "$3")" = staged-lint ]
shift 5
for path do
    if [ "$(cat "$path")" = BAD_LINT ]; then exit 12; fi
done
STUB
chmod +x "$temporary"/bin/*
export MOCK_BIN="$temporary/bin" CHECK_LOG="$temporary/check.log"
export PATH="$MOCK_BIN:$PATH"

source_file='NotificationManager/通知 test.swift'
printf '%s\n' staged-format > .swift-format
printf '%s\n' staged-lint > .swiftlint.yml
printf '%s\n' OK > "$source_file"
git add .
git commit -qm baseline

git worktree add -q --detach "$temporary/sibling" HEAD
make -s install-hooks
make -s install-hooks
[ "$(git config --worktree --get core.hooksPath)" = .githooks ]
[ "$(git -C "$temporary/sibling" config --get core.hooksPath)" = "$temporary/unused-hooks" ]

check_staged() {
    local staged="$1" unstaged="$2" expected="$3" index_tree status=0
    printf '%s\n' "$staged" > "$source_file"
    git add -- "$source_file"
    printf '%s\n' "$unstaged" > "$source_file"
    index_tree=$(git write-tree)
    .githooks/pre-commit > "$temporary/output" 2>&1 || status=$?
    if [ "$expected" = pass ]; then
        [ "$status" -eq 0 ] || { cat "$temporary/output"; exit 1; }
    else
        [ "$status" -ne 0 ] || { echo "Accepted staged $staged"; exit 1; }
    fi
    [ "$(cat "$source_file")" = "$unstaged" ]
    [ "$(git write-tree)" = "$index_tree" ]
}

# Config edits in the worktree also must not affect the hook.
printf '%s\n' unstaged-format > .swift-format
printf '%s\n' unstaged-lint > .swiftlint.yml
check_staged BAD_FORMAT OK fail
check_staged BAD_LINT OK fail
check_staged OK_CHANGED BAD_FORMAT pass
MISSING_SWIFTLINT=1 check_staged OK_CHANGED OK fail

git mv -f -- "$source_file" 'NotificationManager/renamed.swift'
.githooks/pre-commit
[ "$(tail -n 1 "$CHECK_LOG")" = NotificationManager/renamed.swift ]
git rm -f NotificationManager/renamed.swift >/dev/null
printf '%s\n' 'test fixture' > note.txt
git add note.txt
MISSING_SWIFTLINT=1 .githooks/pre-commit

git reset -q --hard HEAD
printf '%s\n' new-format > .swift-format
git add .swift-format
printf '%s\n' unstaged-format > .swift-format
EXPECTED_FORMAT=new-format .githooks/pre-commit
[ "$(tail -n 1 "$CHECK_LOG")" = "$source_file" ]

echo 'Git hook tests passed.'
