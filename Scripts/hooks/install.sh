#!/bin/bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
[ -x .githooks/pre-commit ]

fail() {
    printf 'Cannot install Git hooks: %s\n' "$1" >&2
    exit 1
}

configured=$(git config --path --get core.hooksPath || true)
if [ "$configured" != .githooks ]; then
    if [ -n "$configured" ]; then
        [ ! -e "$configured" ] || fail "existing core.hooksPath is $configured"
    else
        default_hooks=$(git rev-parse --git-path hooks)
        for hook in "$default_hooks"/*; do
            case "$hook" in
                *.sample) continue ;;
            esac
            if [ -f "$hook" ] && [ -x "$hook" ]; then
                fail "an existing hook is installed at $hook"
            fi
        done
    fi
fi

if [ "$(git config --local --bool --get extensions.worktreeConfig || true)" != true ]; then
    if git config --local --get core.worktree >/dev/null ||
        [ "$(git config --local --bool --get core.bare || true)" = true ]; then
        fail 'worktree-specific configuration requires migrating core.worktree or core.bare first'
    fi
    git config --local extensions.worktreeConfig true
fi

if local_path=$(git config --worktree --get core.hooksPath); then
    [ "$local_path" = .githooks ] || fail "this worktree already sets core.hooksPath to $local_path"
fi

git config --worktree core.hooksPath .githooks
printf '%s\n' 'Enabled the pre-commit hook for this worktree.'
