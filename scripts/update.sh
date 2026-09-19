#!/bin/sh
# FreeDeepseekAPI in-place updater (POSIX sh, dash-clean).
#
#   cd <install-dir> && npm run update
#
# Refuses dirty trees, fast-forwards only (your local commits are never
# merged over), runs the test suite before touching the live service, and
# rolls the code back automatically if tests or the post-restart /health
# check fail. The running service keeps serving the old code until the new
# code is proven.
#
# Env:
#   FREEDSEEK_DIR        install root (default: the repo containing this
#                        script, resolved from $0 — POSIX sets $0 to the
#                        script path for `sh path/to/update.sh`; only the
#                        `sh -c '...'` form breaks that).
#   FREEDSEEK_UPSTREAM   <remote>/<branch> to fast-forward to
#                        (default: origin/<current-branch>).
#   FREEDSEEK_NO_RESTART=1   skip the service restart (CI / tests)
#
# Lock and failure marker live under $XDG_RUNTIME_DIR/$XDG_STATE_HOME (or
# /tmp and ~/.local/state) so they never dirty the repo and trip the
# dirty-tree check below.
set -eu

if [ -n "${FREEDSEEK_DIR:-}" ]; then
    REPO_ROOT=$FREEDSEEK_DIR
else
    REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fi
cd "$REPO_ROOT" || exit 2

die() { printf '%s\n' "update: $*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }

[ -d .git ] || die "not a git install ($REPO_ROOT has no .git). Reinstall with the curl installer."

# Concurrency lock (outside the repo so it never dirties the tree).
RUNTIME_DIR="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}"
REPO_KEY=$(printf '%s' "$REPO_ROOT" | cksum | cut -d' ' -f1)
LOCK_DIR="$RUNTIME_DIR/freedeepseek-update-$REPO_KEY.lock"
if [ -d "$LOCK_DIR" ]; then
    if [ -f "$LOCK_DIR/pid" ] && kill -0 "$(cat "$LOCK_DIR/pid" 2>/dev/null)" 2>/dev/null; then
        die "another update is already running (pid $(cat "$LOCK_DIR/pid")); remove $LOCK_DIR if stale."
    fi
    rm -rf "$LOCK_DIR"
fi
mkdir -p "$RUNTIME_DIR"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    die "another update is already running (lock: $LOCK_DIR). Remove it if stale."
fi
printf '%s' "$$" > "$LOCK_DIR/pid"

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/freedeepseek"
FAIL_MARKER="$STATE_DIR/update-last-failed"
TEST_LOG=""
KEEP_LOG=0
cleanup() {
    rm -rf "$LOCK_DIR" 2>/dev/null || true
    if [ -n "${TEST_LOG:-}" ] && [ "${KEEP_LOG:-0}" != "1" ]; then
        rm -f "$TEST_LOG" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

write_failed_marker() {
    mkdir -p "$STATE_DIR" 2>/dev/null || true
    printf '%s %s\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)" > "$FAIL_MARKER" 2>/dev/null || true
}

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || die "cannot determine branch"
if [ "$BRANCH" = "HEAD" ]; then
    die "this install is pinned (detached HEAD). The updater will not move a pinned install; reinstall into a fresh --dir with the desired --ref."
fi
UPSTREAM="${FREEDSEEK_UPSTREAM:-origin/$BRANCH}"
case $UPSTREAM in
    */*) ;;
    *) die "FREEDSEEK_UPSTREAM must be <remote>/<branch>, got: $UPSTREAM";;
esac
REMOTE=${UPSTREAM%%/*}

# Never merge over local work: committed-ahead and dirty trees both stop here.
# NOTE: this relies on the repo's .gitignore covering every secret-bearing
# runtime file (accounts/*.bak, .sessions.json, ...). Before that coverage
# existed, a live install carrying an unignored .bak could never update.
if [ -n "$(git status --porcelain)" ]; then
    die "working tree dirty — commit or stash first (git status), then re-run."
fi
OLD=$(git rev-parse HEAD)

info "Fetching $REMOTE ..."
git fetch "$REMOTE" || die "fetch failed (network?)"
if ! git merge-base --is-ancestor HEAD "$UPSTREAM" 2>/dev/null; then
    # HEAD not behind upstream: either up to date or diverged.
    if git merge-base --is-ancestor "$UPSTREAM" HEAD 2>/dev/null; then
        info "Already up to date ($OLD)."
        exit 0
    fi
    die "local branch diverged from $UPSTREAM — rebase or reset manually, then re-run."
fi
if [ "$(git rev-parse HEAD)" = "$(git rev-parse "$UPSTREAM")" ]; then
    info "Already up to date ($(git rev-parse --short HEAD))."
    exit 0
fi

# Known-bad guard: refuse to retry a commit that already failed this updater.
if [ -f "$FAIL_MARKER" ]; then
    MARKED=$(cut -d' ' -f1 < "$FAIL_MARKER" 2>/dev/null || echo '')
    if [ "$MARKED" = "$(git rev-parse "$UPSTREAM")" ]; then
        die "the previous update to $(git rev-parse --short "$UPSTREAM") failed and was rolled back; refusing to retry it. Delete $FAIL_MARKER to force."
    fi
fi

git merge --ff-only "$UPSTREAM" || die "fast-forward failed"
NEW=$(git rev-parse HEAD)
info "Code: $(git rev-parse --short "$OLD") -> $(git rev-parse --short "$NEW")"

TEST_LOG=$(mktemp "${TMPDIR:-/tmp}/freedeepseek-update-test.XXXXXX") || die "cannot create test log"
if ! npm test >"$TEST_LOG" 2>&1; then
    KEEP_LOG=1
    info "npm test FAILED on new code; last 30 lines (full log: $TEST_LOG):"
    tail -n 30 "$TEST_LOG" >&2 2>/dev/null || true
    git reset --hard "$OLD" >/dev/null
    write_failed_marker "$NEW"
    die "tests FAILED on new code; rolled back to $(git rev-parse --short "$OLD"). Service untouched."
fi
info "Tests green on new code."

if [ "${FREEDSEEK_NO_RESTART:-0}" = "1" ]; then
    info "FREEDSEEK_NO_RESTART=1 — leaving service alone."
    exit 0
fi
if command -v systemctl >/dev/null 2>&1 \
    && systemctl --user list-unit-files freedeepseek.service >/dev/null 2>&1; then
    if systemctl --user is-active freedeepseek.service >/dev/null 2>&1; then
        systemctl --user restart freedeepseek.service
        sleep 8
        if curl -s -m 10 http://127.0.0.1:9655/health >/dev/null 2>&1; then
            info "Service restarted on new code (/health ok)."
        else
            info "WARNING: /health not ok on new code — rolling back to $(git rev-parse --short "$OLD")."
            git reset --hard "$OLD" >/dev/null
            write_failed_marker "$NEW"
            systemctl --user restart freedeepseek.service
            sleep 8
            if curl -s -m 10 http://127.0.0.1:9655/health >/dev/null 2>&1; then
                info "Rolled back to $(git rev-parse --short "$OLD"); service healthy again."
            else
                info "WARNING: service unhealthy after rollback too — journalctl --user -u freedeepseek.service"
            fi
            die "new code failed /health; rolled back to $(git rev-parse --short "$OLD")."
        fi
    else
        info "Service installed but not running — start it: systemctl --user start freedeepseek.service"
    fi
else
    info "No managed service found — start manually: npm start"
fi
info "Update complete: $(git rev-parse --short "$OLD") -> $(git rev-parse --short "$NEW")."
