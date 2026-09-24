#!/bin/sh
# DeepSeek account manager for FreeDeepseekAPI (multi-account auth dir).
#   sh scripts/auth-cli.sh [add|renew|delete|check|import|doctor|restart] [name] [--force]
# Bare run opens the interactive menu. POSIX sh only (dash-clean): no
# bashisms, no `select`, no arrays. Secrets never appear on argv or in logs.
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
AUTH_DIR=${DEEPSEEK_AUTH_DIR:-"$REPO_ROOT/accounts"}
SERVICE_NAME="freedeepseek.service"
TMP_PREFIX=""
FORCE=0

cleanup() {
    # Shred any staging files (secret-bearing) on exit/interrupt.
    # Staging names never end in .json (see TMP_PREFIX uses below) so neither
    # the CLI's *.json globs nor the server loader can pick up half-written
    # secrets — but shred anyway. The .*.$suffix glob also sweeps staging left
    # by crashes from the brief .tmp.json-named revision (2026-09-17).
    if [ -n "$TMP_PREFIX" ]; then
        shred -u "$TMP_PREFIX".tmp "$TMP_PREFIX".hdrs "$TMP_PREFIX".stage "$TMP_PREFIX".restore-list 2>/dev/null \
            || rm -f "$TMP_PREFIX".tmp "$TMP_PREFIX".hdrs "$TMP_PREFIX".stage "$TMP_PREFIX".restore-list 2>/dev/null \
            || true
    fi
    shred -u "$AUTH_DIR"/.*.tmp.json "$AUTH_DIR"/.*.stage.json 2>/dev/null \
        || rm -f "$AUTH_DIR"/.*.tmp.json "$AUTH_DIR"/.*.stage.json 2>/dev/null || true
}
trap 'cleanup' EXIT INT TERM

die() { printf '%s\n' "auth-cli: $*" >&2; exit 2; }
info() { printf '%s\n' "$*"; }
ask() {
    # ask <prompt> <default> -> prints answer (default on empty)
    _prompt=$1 _def=$2 _ans=""
    printf '%s [%s]: ' "$_prompt" "$_def" >&2
    IFS= read -r _ans || true
    if [ -z "$_ans" ]; then _ans=$_def; fi
    printf '%s' "$_ans"
}
ask_yn() {
    # ask_yn <prompt> -> 0 for yes (default Y)
    _a=$(ask "$1" "Y")
    case $_a in [Yy]|[Yy][Ee][Ss]) return 0;; *) return 1;; esac
}
ensure_dir() { mkdir -p "$AUTH_DIR"; }

list_accounts() {
    # prints "<n> <name>" lines for *.json in AUTH_DIR (names = basenames)
    ensure_dir
    _i=0
    for _f in "$AUTH_DIR"/*.json; do
        [ -e "$_f" ] || continue
        case $_f in *.bak|*.bak-*) continue;; esac
        _i=$((_i + 1))
        printf '%d %s\n' "$_i" "$(basename "$_f" .json)"
    done
}
account_count() { list_accounts | wc -l | tr -d ' '; }
name_to_file() {
    # Defence in depth: no path separators ever escape AUTH_DIR, even if a
    # caller forgets valid_name (cmd_delete/cmd_check_one enforce both).
    case $1 in *..*|*/*) die "bad name '$1'";; esac
    printf '%s/%s.json' "$AUTH_DIR" "$1"
}
valid_name() {
    # ^[a-z0-9][a-z0-9_-]{0,31}$ — filename is account identity, keep it tight.
    # The 33-?-plus-star alternative rejects length >= 33 (exactly-33 alone
    # would let 34+ through — caught by review, hence the trailing *).
    case $1 in
        ""|*[!a-z0-9_-]*|[!a-z0-9]*|?????????????????????????????????*) return 1;;
        *) return 0;;
    esac
}
pick_account() {
    # pick_account <verb> -> prints chosen name; q/empty aborts (exit 3)
    _list=$(list_accounts)
    if [ -z "$_list" ]; then die "no accounts in $AUTH_DIR (use Add first)"; fi
    printf 'Choose account to %s (q to cancel):\n%s\n' "$1" "$_list" >&2
    printf 'Number: ' >&2
    IFS= read -r _n || true
    case $_n in q|Q|"") exit 3;; esac
    _name=$(printf '%s\n' "$_list" | awk -v n="$_n" '$1==n{print $2; exit}')
    [ -n "$_name" ] || die "no such number: $_n"
    printf '%s' "$_name"
}
probe_file() {
    # probe_file <path> -> prints "ALIVE 812ms" / "DEAD <reason> 812ms"; exit 0/1
    node "$REPO_ROOT/scripts/probe-account.js" "$1"
}
probe_or_die() {
    # probe_or_die <json> <dead-msg> — exit 2 (unreadable file) is a tool
    # failure, not a dead account; report each honestly.
    if probe_file "$1"; then
        return 0
    elif [ $? -eq 2 ]; then
        die "probe could not run on $1 (unreadable?)"
    else
        die "$2"
    fi
}
probe_json() {
    # probe_json <path> -> prints verdict JSON {ok, reason?, ms}; exit 0/1/2.
    # The --json branch is the structured contract: check/double-tap parse
    # .reason with node -e (never text-scrape human output).
    node "$REPO_ROOT/scripts/probe-account.js" --json "$1"
}
_probe_once() {
    # _probe_once <file> — one structured probe; sets _PV_HUMAN (display line),
    # _PV_REASON ("" when ALIVE) and _PV_CODE (0/1/2). Returns _PV_CODE.
    _PV_JSON=""; _PV_CODE=0; _PV_HUMAN=""; _PV_REASON=""
    if _PV_JSON=$(probe_json "$1"); then _PV_CODE=0; else _PV_CODE=$?; fi
    if [ "$_PV_CODE" -eq 2 ]; then return 2; fi
    _PV_HUMAN=$(node -e 'const j=JSON.parse(process.argv[1]);console.log(j.ok?("ALIVE "+j.ms+"ms"):("DEAD "+j.reason+" "+j.ms+"ms"))' "$_PV_JSON") || return 2
    _PV_REASON=$(node -e 'const j=JSON.parse(process.argv[1]);console.log(j.ok?"":String(j.reason||""))' "$_PV_JSON") || return 2
    return $_PV_CODE
}
is_quarantine_worthy() {
    # is_quarantine_worthy <reason> -> 0 when the reason proves credential-dead.
    # The allowlist lives in probe-account.js (single source); sh never
    # hardcodes its own copy of what "dead" means.
    node -e 'try{process.exit(require(process.argv[2]+"/scripts/probe-account.js").isQuarantineWorthy(String(process.argv[1]||""))?0:1)}catch(e){process.exit(1)}' "${1:-}" "$REPO_ROOT" 2>/dev/null
}
auto_quarantine_on() {
    # Default ON (unset env quarantines). Precedence: NO_QUARANTINE flag beats
    # env; env DEEPSEEK_AUTO_QUARANTINE=0/false/no/off disables (case-insensitive
    # 1/true/yes/on check mirrors doctor.js isTruthy).
    if [ "${NO_QUARANTINE:-0}" = "1" ]; then return 1; fi
    case ${DEEPSEEK_AUTO_QUARANTINE:-} in
        ""|1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) return 0 ;;
        *) return 1 ;;
    esac
}
quarantine_wanted() {
    # 0 when a dead-worthy account should be evaluated (moved or dry-run
    # reported). --dry-run forces evaluation so its report mirrors real logic.
    if [ "${DRY_RUN:-0}" = "1" ]; then return 0; fi
    auto_quarantine_on
}
is_non_interactive() {
    # NON_INTERACTIVE=1/true/yes/on (case-insensitive) means non-interactive.
    case ${NON_INTERACTIVE:-} in
        1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) return 0 ;;
        *) return 1 ;;
    esac
}
quarantine_account_file() {
    # quarantine_account_file <json-path> <reason> — move the account plus its
    # .bak companions into accounts-quarantined-<today>/ (0700 dir, 0600 files),
    # mirroring server quarantineAccount: a sibling dir when the file's parent
    # is "accounts", else inside the file's own dir. Symlinks are skipped;
    # collisions refuse (never overwrite). Prints the undo (auth-cli.sh restore).
    _q_src=$1 _q_reason=${2:-unknown}
    _q_name=$(basename "$_q_src" .json)
    if [ -L "$_q_src" ]; then info "skipped symlink: $_q_src"; return 0; fi
    _q_parent=$(dirname "$_q_src")
    _q_today=$(date +%F)
    case $(basename "$_q_parent") in
        accounts) _q_dir=$(dirname "$_q_parent")/accounts-quarantined-$_q_today ;;
        *) _q_dir=$_q_parent/accounts-quarantined-$_q_today ;;
    esac
    _q_dest=$_q_dir/$_q_name.json
    if [ -e "$_q_dest" ]; then
        info "DEAD $_q_reason (quarantine blocked: $_q_dest already exists — likely a renewed duplicate; remove one manually)"
        return 1
    fi
    if [ "${DRY_RUN:-0}" = "1" ]; then
        info "would quarantine: $_q_name ($_q_reason) -> $_q_dir/"
        return 0
    fi
    mkdir -p "$_q_dir"; chmod 700 "$_q_dir"
    mv "$_q_src" "$_q_dest"
    chmod 600 "$_q_dest"
    for _q_b in "$_q_src".bak "$_q_src".bak-*; do
        [ -e "$_q_b" ] || continue
        [ -L "$_q_b" ] && continue
        _q_bdest=$_q_dir/$(basename "$_q_b")
        if [ -e "$_q_bdest" ]; then info "warning: keeping existing $_q_bdest, left ${_q_b} in quarantine"; continue; fi
        mv "$_q_b" "$_q_bdest"
        chmod 600 "$_q_bdest"
    done
    info "quarantined: $_q_name ($_q_reason) -> $_q_dir/"
    info "undo: sh scripts/auth-cli.sh restore  # then pick $_q_name"
    return 0
}
quarantine_restart_note() {
    # After any quarantine move: offer restart on TTY only (ask_yn defaults Yes
    # on empty input, so never prompt off-TTY); non-interactive runs log instead.
    # Then a fresh-glob count warns when zero live accounts remain (proceeds anyway).
    if [ -t 0 ] && ! is_non_interactive; then
        offer_restart
    else
        info "restart required for quarantine to take effect: systemctl --user restart $SERVICE_NAME"
    fi
    _live=0
    for _f in "$AUTH_DIR"/*.json; do
        [ -e "$_f" ] || continue
        case $_f in *.bak|*.bak-*) continue;; esac
        _live=$((_live + 1))
    done
    if [ "$_live" -eq 0 ]; then
        info "warning: zero live accounts remain — renew or import an account (check will keep failing until then)"
    fi
}
maybe_quarantine() {
    # maybe_quarantine <file> — double-tap + gate + move for a first DEAD
    # verdict held in _PV_REASON. Returns 0 when a real move happened.
    # A first DEAD allowlisted verdict triggers one immediate re-probe; the move
    # needs two consecutive allowlisted verdicts (reasons may shift between taps).
    if ! quarantine_wanted; then return 1; fi
    if ! is_quarantine_worthy "$_PV_REASON"; then return 1; fi
    if _PV2_JSON=$(probe_json "$1"); then _PV2_CODE=0; else _PV2_CODE=$?; fi
    if [ "$_PV2_CODE" -ne 1 ]; then return 1; fi
    _PV2_REASON=$(node -e 'const j=JSON.parse(process.argv[1]);console.log(String(j.reason||""))' "$_PV2_JSON" 2>/dev/null) || return 1
    if ! is_quarantine_worthy "$_PV2_REASON"; then return 1; fi
    if ! quarantine_account_file "$1" "$_PV2_REASON"; then return 1; fi
    if [ "${DRY_RUN:-0}" = "1" ]; then return 1; fi
    return 0
}
valid_device_id() {
    # valid_device_id <value> — single shared charset/length gate (L7-R2):
    # capture prompt, seed copy, and any future smoke test use one definition.
    # Empty is invalid here (callers handle skip separately).
    case $1 in "") return 1;; esac
    case $1 in *[!A-Za-z0-9_.:~/-]*) return 1;; esac
    [ "${#1}" -gt 128 ] && return 1
    return 0
}
maybe_add_device_id() {
    # maybe_add_device_id <json> — one prompt, merged into the staged file.
    # Value travels via env (same-user-only), never argv — same rule as tokens.
    # Empty answer keeps any id already staged (renew pre-seeds, see below).
    _tries=0
    while [ $_tries -lt 3 ]; do
        _d=$(ask "Machine device_id (browser localStorage key deepseek-device-id:chat; ENTER to skip)" "")
        printf '\n' >&2
        [ -z "$_d" ] && return 0
        if valid_device_id "$_d"; then break; fi
        info "rejected: allowed chars are A-Z a-z 0-9 _ . : ~ / - (max 128)"
        _tries=$((_tries + 1))
    done
    # Post-loop re-validation (M6-R1): the 3rd rejection exits the loop with an
    # invalid non-empty value — never persist what was just rejected.
    if ! valid_device_id "$_d"; then info "giving up on device_id — leaving staged file unchanged"; return 0; fi
    DEEPSEEK_DEVICE_ID="$_d" node -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));const v=String(process.env.DEEPSEEK_DEVICE_ID||"").trim();if(v){j.device_id=v}else{delete j.device_id}fs.writeFileSync(p,JSON.stringify(j,null,2));fs.chmodSync(p,0o600);' "$1"
    info "device_id recorded"
}
seed_device_id() {
    # seed_device_id <live.json> <staging.json> — carry the machine id across
    # renewals (M5-R1). Validates like capture (L7-R1): a hand-corrupted live id
    # is skipped, never propagated — seeded-absent behaves exactly like no id.
    node -e 'const fs=require("fs");const l=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const id=l&&l.device_id;if(typeof id!=="string"||!/^[A-Za-z0-9_.:~/-]{1,128}$/.test(id))return;const p=process.argv[2];const s=JSON.parse(fs.readFileSync(p,"utf8"));s.device_id=id;fs.writeFileSync(p,JSON.stringify(s,null,2));fs.chmodSync(p,0o600);' "$1" "$2" 2>/dev/null || true
}
node_has_token() {    # node_has_token <json> -> 0 if file parses and has non-empty token
    node -e 'try{const a=require("fs").readFileSync(process.argv[1],"utf8");const j=JSON.parse(a);process.exit(j&&j.token?0:1)}catch(e){process.exit(1)}' "$1" 2>/dev/null
}
install_staged() {
    # install_staged <staging-file> <dest.json> — house .bak rule included
    _staging=$1 _dest=$2
    if [ -f "$_dest" ] && node_has_token "$_dest"; then
        cp "$_dest" "$_dest.bak"
        info "backup: $_dest.bak"
    fi
    chmod 600 "$_staging"
    mv "$_staging" "$_dest"
    chmod 600 "$_dest"
    info "installed: $_dest"
}
offer_restart() {
    if ! ask_yn "Restart proxy now?"; then return 0; fi
    restart_service
}
restart_service() {
    if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active "$SERVICE_NAME" >/dev/null 2>&1; then
        systemctl --user restart "$SERVICE_NAME"
        sleep 8
        if curl -s -m 10 http://127.0.0.1:9655/health >/dev/null 2>&1; then
            info "proxy restarted, /health ok"
        else
            info "restart issued but /health not ok — check: journalctl --user -u $SERVICE_NAME"
            return 1
        fi
    else
        info "service not managed here; restart manually:"
        info "  cd $REPO_ROOT && DEEPSEEK_AUTH_DIR=$AUTH_DIR NON_INTERACTIVE=1 nohup node server.js > /tmp/proxy.log 2>&1 &"
    fi
}
resolve_chrome() {
    if [ -n "${CHROME_PATH:-}" ]; then printf '%s' "$CHROME_PATH"; return 0; fi
    for _c in "$(command -v chromium 2>/dev/null)" "$(command -v chromium-browser 2>/dev/null)" "$(command -v google-chrome 2>/dev/null)"; do
        if [ -n "$_c" ]; then printf '%s' "$_c"; return 0; fi
    done
    return 1
}

cmd_add() {
    _name=${1:-}
    if [ -z "$_name" ]; then _name=$(ask "Account name (a-z, 0-9, _-)" ""); printf '\n' >&2; fi
    valid_name "$_name" || die "bad name '$_name': use ^[a-z0-9][a-z0-9_-]{0,31}\$"
    _dest=$(name_to_file "$_name")
    [ -e "$_dest" ] && die "$_dest exists — use Renew (2) instead"
    _chrome=$(resolve_chrome) || die "no Chromium found; set CHROME_PATH (see: npm run auth error text)"
    TMP_PREFIX="$AUTH_DIR/.$_name.add-$$"
    info "Opening Chromium — log in, send any short message, then press ENTER in that terminal..."
    CHROME_PATH="$_chrome" DEEPSEEK_AUTH_PATH="$TMP_PREFIX.tmp" node "$REPO_ROOT/scripts/deepseek_chrome_auth.js"
    _c=$?
    if [ $_c -ne 0 ]; then
        die "login incomplete (exit $_c) — nothing written"
    fi
    maybe_add_device_id "$TMP_PREFIX.tmp"
    info "Probing fresh credentials..."
    probe_or_die "$TMP_PREFIX.tmp" "probe says DEAD — staging kept out of live files; retry Add when logged in"
    install_staged "$TMP_PREFIX.tmp" "$_dest"
    TMP_PREFIX=""
    offer_restart
}
list_accounts_for_renew() {
    _i=0
    for _f in "$AUTH_DIR"/*.json; do
        [ -e "$_f" ] || continue
        case $_f in *.bak|*.bak-*) continue;; esac
        _i=$((_i + 1))
        printf '%d %s [live] %s\n' "$_i" "$(basename "$_f" .json)" "$_f"
    done
    for _d in "$REPO_ROOT"/accounts-quarantined-*; do
        [ -d "$_d" ] || continue
        [ -L "$_d" ] && continue
        for _f in "$_d"/*.json; do
            [ -e "$_f" ] || continue
            [ -L "$_f" ] && continue
            case $_f in *.bak|*.bak-*) continue;; esac
            _i=$((_i + 1))
            printf '%d %s [quarantined] %s\n' "$_i" "$(basename "$_f" .json)" "$_f"
        done
    done
}
cmd_renew() {
    _name=${1:-}
    _src_quarantine=""
    if [ -z "$_name" ]; then
        TMP_PREFIX="$AUTH_DIR/.renew-$$"
        umask 077
        list_accounts_for_renew > "$TMP_PREFIX.renew-list"
        _total=$(wc -l < "$TMP_PREFIX.renew-list" | tr -d ' ')
        if [ "$_total" -eq 0 ]; then
            rm -f "$TMP_PREFIX.renew-list"
            TMP_PREFIX=""
            die "no accounts in $AUTH_DIR or quarantine (use Add first)"
        fi
        printf 'Choose account to renew (q to cancel):\n' >&2
        awk '{printf "  %2d. %-20s %s\n", $1, $2, $3}' "$TMP_PREFIX.renew-list" >&2
        printf 'Number: ' >&2
        IFS= read -r _n || true
        case $_n in q|Q|"") rm -f "$TMP_PREFIX.renew-list"; TMP_PREFIX=""; exit 3;; esac
        case $_n in *[!0-9]*|"") rm -f "$TMP_PREFIX.renew-list"; TMP_PREFIX=""; die "not a number: $_n";; esac
        _line=$(awk -v n="$_n" '$1==n{print; exit}' "$TMP_PREFIX.renew-list")
        rm -f "$TMP_PREFIX.renew-list"
        TMP_PREFIX=""
        [ -n "$_line" ] || die "no such number: $_n"
        _name=$(printf '%s' "$_line" | awk '{print $2}')
        _type=$(printf '%s' "$_line" | awk '{print $3}')
        _src_file=$(printf '%s' "$_line" | awk '{print $4}')
        if [ "$_type" = "[quarantined]" ]; then
            _src_quarantine="$_src_file"
        fi
    else
        _dest=$(name_to_file "$_name")
        if [ ! -f "$_dest" ]; then
            for _d in "$REPO_ROOT"/accounts-quarantined-*; do
                [ -d "$_d" ] || continue
                if [ -f "$_d/$_name.json" ]; then
                    _src_quarantine="$_d/$_name.json"
                    break
                fi
            done
        fi
    fi
    valid_name "$_name" || die "bad name '$_name'"
    _dest=$(name_to_file "$_name")
    if [ -z "$_src_quarantine" ] && [ ! -f "$_dest" ]; then
        die "no such account: $_name (not in accounts/ or quarantine; use Add first)"
    fi
    _chrome=$(resolve_chrome) || die "no Chromium found; set CHROME_PATH"
    TMP_PREFIX="$AUTH_DIR/.$_name.renew-$$"
    if [ -n "$_src_quarantine" ]; then
        info "Opening Chromium to renew quarantined account '$_name' (will restore to live accounts)..."
    else
        info "Opening Chromium to renew '$_name' (filename never changes)..."
    fi
    CHROME_PATH="$_chrome" DEEPSEEK_AUTH_PATH="$TMP_PREFIX.tmp" node "$REPO_ROOT/scripts/deepseek_chrome_auth.js"
    _c=$?
    if [ $_c -ne 0 ]; then
        die "login incomplete (exit $_c) — '$_name' left untouched"
    fi
    if [ -n "$_src_quarantine" ]; then
        seed_device_id "$_src_quarantine" "$TMP_PREFIX.tmp"
    else
        seed_device_id "$_dest" "$TMP_PREFIX.tmp"
    fi
    maybe_add_device_id "$TMP_PREFIX.tmp"
    info "Probing fresh credentials..."
    probe_or_die "$TMP_PREFIX.tmp" "probe says DEAD — '$_name' left untouched"
    install_staged "$TMP_PREFIX.tmp" "$_dest"
    if [ -n "$_src_quarantine" ] && [ -f "$_src_quarantine" ]; then
        _qdir=$(dirname "$_src_quarantine")
        rm -f "$_src_quarantine" "$_src_quarantine.bak"* 2>/dev/null || true
        info "restored from quarantine: $_name -> accounts/"
        rmdir "$_qdir" 2>/dev/null || true
    fi
    TMP_PREFIX=""
    offer_restart
}
restore_count() {
    _i=0
    for _d in "$REPO_ROOT"/accounts-quarantined-*; do
        [ -d "$_d" ] || continue
        [ -L "$_d" ] && continue
        for _f in "$_d"/*.json; do
            [ -e "$_f" ] || continue
            [ -L "$_f" ] && continue
            case $_f in *.bak|*.bak-*) continue;; esac
            _i=$((_i + 1))
            printf '%d %s\n' "$_i" "$_f"
        done
    done
}
cmd_restore() {
    info "Quarantined accounts (probed read-only; moved back only if ALIVE):"
    # Single snapshot for display AND pick (M-R1): re-globbing after the
    # operator types would let a concurrent dir change remap numbers.
    TMP_PREFIX="$AUTH_DIR/.restore-$$"
    umask 077
    : > "$TMP_PREFIX.restore-list"
    chmod 600 "$TMP_PREFIX.restore-list"
    restore_count > "$TMP_PREFIX.restore-list"
    cat "$TMP_PREFIX.restore-list" >&2
    _total=$(wc -l < "$TMP_PREFIX.restore-list" | tr -d ' ')
    if [ "$_total" -eq 0 ]; then info "none quarantined"; rm -f "$TMP_PREFIX.restore-list"; TMP_PREFIX=""; return 0; fi
    printf 'Number to restore (q to cancel): ' >&2
    IFS= read -r _n || true
    case $_n in q|Q|"") return 0;; esac
    case $_n in *[!0-9]*|"") die "not a number: $_n";; esac
    _src=$(sed -n "${_n}p" "$TMP_PREFIX.restore-list" | awk '{sub(/^[0-9]+ /,""); print}')
    if [ -n "${_src:-}" ] && [ -e "$_src" ]; then :; else rm -f "$TMP_PREFIX.restore-list"; TMP_PREFIX=""; die "no such number: $_n"; fi
    _base=$(basename "$_src" .json)
    valid_name "$_base" || die "quarantined name '$_base' is not a valid account name — rename the file first"
    _dest=$(name_to_file "$_base")
    [ -e "$_dest" ] && die "$_dest already live — renew it instead"
    printf 'Restore %s from %s? [y/N]: ' "$_base" "$_src" >&2
    IFS= read -r _ok || true
    case $_ok in [Yy]|[Yy][Ee][Ss]) ;; *) info "cancelled — nothing moved"; return 0;; esac
    info "Probing quarantined file (no changes yet)..."
    if ! probe_file "$_src"; then
        info "still dead — left quarantined"
        return 1
    fi
    mv "$_src" "$_dest"
    chmod 600 "$_dest"
    for _b in "$_src".bak "$_src".bak-*; do
        [ -e "$_b" ] || continue
        _suffix=${_b##*.json}
        case $_suffix in .* ) ;; *) _suffix=".bak";; esac
        _bdest="$AUTH_DIR/$_base$_suffix"
        if [ -e "$_bdest" ]; then info "warning: keeping existing $_bdest, left ${_b} in quarantine"; continue; fi
        mv "$_b" "$_bdest"
    done
    info "restored: $_base -> accounts/"
    info "note: account_N ids are positional — verify DEEPSEEK_PREFERRED_ACCOUNT still points where intended"
    rm -f "$TMP_PREFIX.restore-list"
    TMP_PREFIX=""
    offer_restart
}
cmd_rename() {
    _old=${1:-}
    if [ -z "$_old" ]; then
        _old=$(pick_account "rename") || exit $?
    fi
    valid_name "$_old" || die "bad name '$_old'"
    _src=$(name_to_file "$_old")
    [ -f "$_src" ] || die "no such account: $_old"
    _new=${2:-}
    if [ -z "$_new" ]; then _new=$(ask "New name" ""); printf '\n' >&2; fi
    valid_name "$_new" || die "bad name '$_new': use ^[a-z0-9][a-z0-9_-]{0,31}\$"
    _dest=$(name_to_file "$_new")
    [ -e "$_dest" ] && die "$_dest exists — pick another name"
    mv "$_src" "$_dest"
    chmod 600 "$_dest"
    for _b in "$_src".bak "$_src".bak-*; do
        [ -e "$_b" ] || continue
        _suffix=${_b##*.json}
        case $_suffix in .* ) ;; *) _suffix=".bak";; esac
        _bdest="$AUTH_DIR/$_new$_suffix"
        if [ -e "$_bdest" ]; then info "warning: keeping existing $_bdest, left ${_b} behind"; continue; fi
        mv "$_b" "$_bdest"
    done
    info "renamed: $_old -> $_new"
    info "new account order (ids are positional — verify DEEPSEEK_PREFERRED_ACCOUNT):"
    list_accounts | awk '{printf "  account_%d = %s\n", $1, $2}'
    if [ -n "${DEEPSEEK_PREFERRED_ACCOUNT:-}" ]; then
        info "note: DEEPSEEK_PREFERRED_ACCOUNT=$DEEPSEEK_PREFERRED_ACCOUNT may now point elsewhere"
    fi
    offer_restart
}
cmd_delete() {    _name=${1:-}
    if [ -z "$_name" ]; then
        _name=$(pick_account "delete") || exit $?
    fi
    # pick_account output is filename-derived (safe), but direct argv is not —
    # validate both: filename is account identity, no path separators ever.
    valid_name "$_name" || die "bad name '$_name'"
    _dest=$(name_to_file "$_name")
    [ -f "$_dest" ] || die "no such account: $_name"
    if [ "$(account_count)" -le 1 ] && [ "$FORCE" -eq 0 ]; then
        die "refusing to delete the last account (pass --force to override)"
    fi
    printf 'Type the account name to confirm deletion: ' >&2
    IFS= read -r _confirm || true
    [ "$_confirm" = "$_name" ] || die "confirmation mismatch — nothing deleted"
    if ! command -v shred >/dev/null 2>&1; then
        info "warning: shred not found — falling back to rm (bytes may remain on disk)"
    fi
    shred -u "$_dest" 2>/dev/null || rm -f "$_dest"
    for _b in "$_dest".bak "$_dest".bak-*; do
        [ -e "$_b" ] || continue
        shred -u "$_b" 2>/dev/null || rm -f "$_b"
    done
    info "deleted: $_name"
    offer_restart
}
cmd_check_one() {
    # cmd_check_one <name> -> prints "<name>: <verdict>"; exit 0/1 (2 when the
    # probe itself could not run). Single-account check has no quorum, so no
    # circuit breaker here — double-tap only (documented asymmetry with check all).
    valid_name "$1" || die "bad name '$1'"
    _dest=$(name_to_file "$1")
    [ -f "$_dest" ] || die "no such account: $1"
    if _probe_once "$_dest"; then _code=0; else _code=$?; fi
    if [ "$_code" -eq 2 ]; then
        printf '%s: PROBE-FAILED (unreadable?)\n' "$1"
        return 2
    fi
    printf '%s: %s\n' "$1" "$_PV_HUMAN"
    if [ "$_code" -ne 0 ] && maybe_quarantine "$_dest"; then
        quarantine_restart_note
    fi
    return $_code
}
cmd_check() {
    # cmd_check [--no-quarantine] [--dry-run] [all|<name>] — check defaults to
    # auto-quarantine; exit 1 when any account is dead (moves never mask it).
    NO_QUARANTINE=0; DRY_RUN=0; _target=""
    for _a in "$@"; do
        case $_a in
            --no-quarantine) NO_QUARANTINE=1 ;;
            --dry-run) DRY_RUN=1 ;;
            --force) ;; # global, already consumed by main
            --*) die "unknown check flag: $_a" ;;
            *) _target=$_a ;;
        esac
    done
    if [ -z "$_target" ] || [ "$_target" = "all" ]; then
        _fail=0 _i=0 _n_verdict=0 _n_dead=0 _n_probefail=0 _moved=0 _pending=""
        for _f in "$AUTH_DIR"/*.json; do
            [ -e "$_f" ] || continue
            case $_f in *.bak|*.bak-*) continue;; esac
            _i=$((_i + 1))
            _name=$(basename "$_f" .json)
            if _probe_once "$_f"; then _pcode=0; else _pcode=$?; fi
            if [ "$_pcode" -eq 2 ]; then
                printf 'account_%d %s: PROBE-FAILED (unreadable?)\n' "$_i" "$_name"
                _fail=1
                # Tool failure, not a verdict: never counts toward the
                # breaker quorum either way; reported in the summary below.
                _n_probefail=$((_n_probefail + 1))
                continue
            fi
            _n_verdict=$((_n_verdict + 1))
            printf 'account_%d %s: %s\n' "$_i" "$_name" "$_PV_HUMAN"
            if [ "$_pcode" -ne 0 ]; then
                _fail=1
                _n_dead=$((_n_dead + 1))
                # Defer moves until the breaker quorum is known; confirm the
                # double-tap now so the report mirrors real logic (incl. --dry-run).
                if quarantine_wanted && is_quarantine_worthy "$_PV_REASON"; then
                    if _PV2_JSON=$(probe_json "$_f"); then _PV2_CODE=0; else _PV2_CODE=$?; fi
                    if [ "$_PV2_CODE" -eq 1 ]; then
                        _PV2_REASON=$(node -e 'const j=JSON.parse(process.argv[1]);console.log(String(j.reason||""))' "$_PV2_JSON" 2>/dev/null) || _PV2_REASON=""
                        if [ -n "$_PV2_REASON" ] && is_quarantine_worthy "$_PV2_REASON"; then
                            _pending=$_pending$_f" | "$_PV2_REASON"
"
                        fi
                    fi
                fi
            fi
        done
        [ "$_i" -gt 0 ] || die "no accounts in $AUTH_DIR"
        if [ "$_n_probefail" -gt 0 ]; then
            info "$_n_probefail probe-failure(s) excluded from quorum"
        fi
        if [ "$_n_verdict" -gt 1 ] && [ "$_n_dead" -eq "$_n_verdict" ]; then
            # Mass-quarantine circuit breaker (quorum-gated: a lone dead
            # account is actionable, not an incident): every probed account
            # dead is evidence of an upstream incident, not N independent
            # deaths.
            info "all accounts dead — suspected upstream incident; quarantined nothing"
            return 1
        fi
        while IFS= read -r _pline; do
            [ -n "$_pline" ] || continue
            _pf=${_pline% | *}; _pr=${_pline##*| }
            if [ "${DRY_RUN:-0}" = "1" ]; then
                quarantine_account_file "$_pf" "$_pr" || true
            else
                if quarantine_account_file "$_pf" "$_pr"; then _moved=$((_moved + 1)); fi
            fi
        done <<EOF
$_pending
EOF
        if [ "$_moved" -gt 0 ]; then quarantine_restart_note; fi
        return $_fail
    fi
    cmd_check_one "$_target"
}
cmd_import() {
    _mode=${1:-}
    if [ -z "$_mode" ]; then
        printf 'Import from:\n  1. File (auth json / cookie export)\n  2. Pasted request headers\nChoose [1]: ' >&2
        IFS= read -r _mode || true
        : "${_mode:=1}"
    fi
    printf 'Account name: ' >&2
    IFS= read -r _name || true
    valid_name "$_name" || die "bad name '$_name'"
    _dest=$(name_to_file "$_name")
    [ -e "$_dest" ] && die "$_dest exists — use Renew instead"
    TMP_PREFIX="$AUTH_DIR/.$_name.import-$$"
    case $_mode in
        1|file)
            printf 'Source file path: ' >&2
            IFS= read -r _src || true
            [ -f "$_src" ] || die "no such file: $_src"
            DEEPSEEK_AUTH_PATH="$TMP_PREFIX.stage" node "$REPO_ROOT/scripts/auth_import.js" --input "$_src" --output "$TMP_PREFIX.stage" \
                || die "import validation failed"
            ;;
        2|headers)
            info "Paste request headers (need authorization: + cookie: lines). Empty line to finish:"
            umask 077
            rm -f "$TMP_PREFIX.hdrs"
            : > "$TMP_PREFIX.hdrs"
            chmod 600 "$TMP_PREFIX.hdrs"
            while IFS= read -r _line; do
                [ -z "$_line" ] && break
                printf '%s\n' "$_line" >> "$TMP_PREFIX.hdrs"
            done
            node -e '
const fs = require("fs");
const hdrs = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/);
let token = "", cookie = "";
for (const ln of hdrs) {
    const m = ln.match(/^\s*([^:]+)\s*:\s*(.*)\s*$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2];
    if (!token && k === "authorization" && /^Bearer\s+/i.test(v)) token = v.replace(/^Bearer\s+/i, "");
    if (!cookie && k === "cookie" && v) cookie = v;
}
if (!token || !cookie) { console.error("[headers-import] need both authorization: Bearer and cookie: lines"); process.exit(2); }
const { normalizeAuth, validateAuth, secureWriteJson } = require(process.argv[3] + "/scripts/auth_import.js");
const auth = normalizeAuth({ token, cookie });
const errs = validateAuth(auth);
if (errs.length) { console.error("[headers-import] invalid: " + errs.join(", ")); process.exit(2); }
secureWriteJson(process.argv[2], auth);
console.log("[headers-import] staged (" + token.length + "-char token)");
' "$TMP_PREFIX.hdrs" "$TMP_PREFIX.stage" "$REPO_ROOT" || die "headers parse failed"
            ;;
        *) die "unknown import mode: $_mode (1=file, 2=headers)";;
    esac
    info "Probing..."
    probe_or_die "$TMP_PREFIX.stage" "probe says DEAD — nothing installed"
    install_staged "$TMP_PREFIX.stage" "$_dest"
    TMP_PREFIX=""
    offer_restart
}
cmd_doctor() {
    # cmd_doctor [--quarantine] [--offline] — diagnose-don't-mutate by default;
    # --quarantine opts into moving doctor-proven dead accounts (no circuit
    # breaker here: the flag is already deliberate). doctor.js only prints
    # QUARANTINE_CANDIDATE lines; all filesystem moves stay in sh.
    _wantq=0 _off=""
    for _a in "$@"; do
        case $_a in
            --quarantine) _wantq=1 ;;
            --offline) _off="--offline" ;;
            --force) ;; # global, already consumed by main
            *) die "unknown doctor flag: $_a" ;;
        esac
    done
    DRY_RUN=0
    if [ "$_wantq" -eq 0 ]; then
        # _off holds at most one known flag; unquoted split is intentional.
        DEEPSEEK_AUTH_DIR="$AUTH_DIR" node "$REPO_ROOT/scripts/doctor.js" $_off
        return $?
    fi
    if _doc_out=$(DEEPSEEK_AUTH_DIR="$AUTH_DIR" node "$REPO_ROOT/scripts/doctor.js" --quarantine $_off); then _doc_code=0; else _doc_code=$?; fi
    printf '%s\n' "$_doc_out"
    _moved=0
    while IFS= read -r _line; do
        case $_line in
            "QUARANTINE_CANDIDATE "*)
                _cand=${_line#QUARANTINE_CANDIDATE }
                _c_reason=${_cand##* }
                _c_file=${_cand% *}
                [ -f "$_c_file" ] || continue
                is_quarantine_worthy "$_c_reason" || continue
                if quarantine_account_file "$_c_file" "$_c_reason"; then _moved=$((_moved + 1)); fi
                ;;
        esac
    done <<EOF
$_doc_out
EOF
    if [ "$_moved" -gt 0 ]; then quarantine_restart_note; fi
    return $_doc_code
}
show_menu() {
    info ""
    info "DeepSeek accounts ($AUTH_DIR)"
    info "  1. Add account     2. Renew account    3. Delete account"
    info "  4. Check accounts  5. Import           6. Doctor"
    info "  7. Restart proxy   8. Rename account   9. Restore quarantined"
    info "  0. Exit"
}
usage() {
    printf 'usage: %s [add|renew|rename|restore|delete|check|import|doctor|restart] [name] [--force]\n' "$(basename -- "$0")" >&2
    printf '  check [--no-quarantine] [--dry-run] [all|name]; doctor [--quarantine] [--offline]\n' >&2
    exit 2
}

main() {
    _op=${1:-}
    for _a in "$@"; do if [ "$_a" = "--force" ]; then FORCE=1; fi; done
    case $_op in
        "" )
            [ -t 0 ] || usage
            while true; do
                show_menu
                printf 'Choose: ' >&2
                IFS= read -r _c || break
                # Subshells + || true: errors end the action, never the menu
                # (verified: set -eu kills the loop on a failing subshell).
                # Staging cleanup still runs via the EXIT trap in each subshell.
                case $_c in
                    1) (cmd_add) || true ;;
                    2) (cmd_renew) || true ;;
                    3) (cmd_delete) || true ;;
                    4) printf 'Check one or all? [all]: ' >&2; IFS= read -r _w || break; : "${_w:=all}"
                       if [ "$_w" = "all" ]; then (cmd_check all) || true; else ( _n=$(pick_account "check") && cmd_check "$_n" ) || true; fi ;;
                    5) (cmd_import) || true ;;
                    6) (cmd_doctor) || true ;;
                    7) (restart_service) || true ;;
                    8) (cmd_rename) || true ;;
                    9) (cmd_restore) || true ;;
                    0|q|Q) break ;;
                    *) info "unknown choice: $_c" ;;
                esac
                info ""
            done
            ;;
        add) cmd_add "${2:-}" ;;
        renew) cmd_renew "${2:-}" ;;
        rename) cmd_rename "${2:-}" "${3:-}" ;;
        restore) cmd_restore ;;
        delete) cmd_delete "${2:-}" ;;
        check) shift; cmd_check "$@" ;;
        import) cmd_import "${2:-}" ;;
        doctor) shift; cmd_doctor "$@" ;;
        restart) restart_service ;;
        -h|--help|help) usage ;;
        *) usage ;;
    esac
}
main "$@"
