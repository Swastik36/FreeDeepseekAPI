#!/bin/sh
# FreeDeepseekAPI one-line installer (POSIX sh, dash-clean).
#
#   curl -fsSL https://raw.githubusercontent.com/Swastik36/FreeDeepseekAPI/main/scripts/install.sh | sh
#
# Platforms: Linux and macOS run this natively (POSIX sh is preinstalled).
# Windows runs it under Git Bash, which ships with Git for Windows — and git
# is a hard requirement below, so the prerequisite set does not grow. Run the
# whole install/update flow from a Git Bash prompt on Windows; `npm run update`
# from cmd.exe/PowerShell cannot find `sh`.
# (Deliberately not rewritten in Node: the scripts shell out to git and
# systemctl anyway, so a Node port would keep every platform seam while
# doubling the maintenance and test surface.)
#
# Env/flags:
#   FREEDSEEK_REPO_URL / --repo URL   source repo (default: the Swastik36 fork, where releases land)
#   FREEDSEEK_REF / --ref REF         branch/tag to install (default: main)
#   FREEDSEEK_DIR / --dir DIR         install location (default: ~/.local/share/freedeepseek-api)
#   FREEDSEEK_UNIT_DIR                systemd user-unit dir (default: ~/.config/systemd/user)
#   --no-service                       skip systemd unit install
#   --no-auth                          skip interactive login (service installed but not started)
#
# If DIR already holds an install, this hands off to scripts/update.sh instead.
# All prompts read from /dev/tty so curl|sh keeps working.
set -eu

REPO_URL="${FREEDSEEK_REPO_URL:-https://github.com/Swastik36/FreeDeepseekAPI.git}"
REF="${FREEDSEEK_REF:-main}"
DIR="${FREEDSEEK_DIR:-$HOME/.local/share/freedeepseek-api}"
DO_SERVICE=1
DO_AUTH=1

usage() {
    cat <<'USAGE'
usage: install.sh [options]

  --repo URL     source repo (default: https://github.com/Swastik36/FreeDeepseekAPI.git)
  --ref REF      branch or tag to install (default: main)
  --dir DIR      install location (default: ~/.local/share/freedeepseek-api)
  --no-service   skip the systemd user unit
  --no-auth      skip the interactive DeepSeek login

Env: FREEDSEEK_REPO_URL, FREEDSEEK_REF, FREEDSEEK_DIR, FREEDSEEK_UNIT_DIR
USAGE
}

while [ $# -gt 0 ]; do
    case $1 in
        --repo) REPO_URL=$2; shift 2;;
        --ref) REF=$2; shift 2;;
        --dir) DIR=$2; shift 2;;
        --no-service) DO_SERVICE=0; shift;;
        --no-auth) DO_AUTH=0; shift;;
        -h|--help) usage; exit 0;;
        *) echo "install: unknown flag $1" >&2; exit 2;;
    esac
done

die() { printf '%s\n' "install: $*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }
ask_yn() {
    # ask_yn <prompt> -> 0 for yes (default Y); reads /dev/tty for curl|sh
    printf '%s [Y/n]: ' "$1" >&2
    _a=""; IFS= read -r _a </dev/tty || true
    case ${_a:-Y} in [Yy]|"") return 0;; *) return 1;; esac
}
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

need git
need node
NODE_BIN=$(command -v node)
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 18 ] || die "node >= 18 required (found: $(node -v 2>/dev/null || echo none))"

# Existing install -> update path, not a fresh clone.
if [ -d "$DIR/.git" ]; then
    if [ "$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)" = "HEAD" ]; then
        die "$DIR is a pinned (detached-HEAD) install. Reinstall into a fresh --dir with the desired --ref; the in-place updater will not move a pinned install."
    fi
    info "Existing install at $DIR — running updater instead."
    sh "$DIR/scripts/update.sh"
    exit $?
fi
[ -e "$DIR" ] && die "$DIR exists but is not a FreeDeepseekAPI install (no .git). Move it or pass --dir."

info "Cloning $REPO_URL ($REF) into $DIR ..."
git clone --branch "$REF" "$REPO_URL" "$DIR" || die "clone failed"
cd "$DIR" || die "cannot cd $DIR"
SHA=$(git rev-parse --short HEAD)
info "Installed commit $SHA."

if [ "$DO_AUTH" -eq 1 ]; then
    if ask_yn "Log in to DeepSeek now? (opens a browser window)"; then
        sh scripts/auth-cli.sh || info "Auth skipped — run later: cd $DIR && sh scripts/auth-cli.sh"
    fi
fi

UNIT_DIR="${FREEDSEEK_UNIT_DIR:-$HOME/.config/systemd/user}"
UNIT_FILE="$UNIT_DIR/freedeepseek.service"
if [ "$DO_SERVICE" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=FreeDeepseekAPI proxy (DeepSeek Web -> OpenAI-compatible on 127.0.0.1:9655)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=NON_INTERACTIVE=1
Environment=PORT=9655
Environment=HOST=127.0.0.1
Environment=DEEPSEEK_DELTA_PROMPT=1
ExecStart="$NODE_BIN" "$DIR/server.js"
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
    chmod 644 "$UNIT_FILE"
    # systemctl can exist without a live user bus (containers, WSL1, bare SSH
    # without a PAM session). Under `set -e` an unguarded daemon-reload aborts
    # the whole installer; degrade gracefully instead.
    if ! systemctl --user daemon-reload 2>/dev/null; then
        info "Unit written to $UNIT_FILE but the systemd user bus is unreachable."
        info "Start manually instead: cd $DIR && npm start"
        exit 0
    fi
    systemctl --user enable freedeepseek.service >/dev/null
    info "Service installed: $UNIT_FILE"
    if ls "$DIR"/accounts/*.json >/dev/null 2>&1; then
        systemctl --user restart freedeepseek.service
        sleep 8
        if curl -s -m 10 http://127.0.0.1:9655/health >/dev/null 2>&1; then
            info "Proxy live at http://127.0.0.1:9655 (/health ok)."
        else
            info "Service started but /health not ok — check: journalctl --user -u freedeepseek.service"
        fi
    else
        info "No accounts yet — service enabled but not started. Run: cd $DIR && sh scripts/auth-cli.sh"
        info "Then: systemctl --user start freedeepseek.service"
    fi
elif [ "$DO_SERVICE" -eq 1 ]; then
    info "No systemctl found — start manually: cd $DIR && npm start"
    info "Windows (Git Bash): keep a prompt open with 'npm start', or schedule it via Task Scheduler."
fi

info "Done ($SHA). Update later with: cd $DIR && npm run update"
info "(or re-run this installer — it detects the install and updates)."
