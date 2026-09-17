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
node_has_token() {
    # node_has_token <json> -> 0 if file parses and has non-empty token
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
    info "Probing fresh credentials..."
    probe_or_die "$TMP_PREFIX.tmp" "probe says DEAD — staging kept out of live files; retry Add when logged in"
    install_staged "$TMP_PREFIX.tmp" "$_dest"
    TMP_PREFIX=""
    offer_restart
}
cmd_renew() {
    _name=${1:-}
    if [ -z "$_name" ]; then
        _name=$(pick_account "renew") || exit $?
    fi
    valid_name "$_name" || die "bad name '$_name'"
    _dest=$(name_to_file "$_name")
    [ -f "$_dest" ] || die "no such account: $_name (use Add first)"
    _chrome=$(resolve_chrome) || die "no Chromium found; set CHROME_PATH"
    TMP_PREFIX="$AUTH_DIR/.$_name.renew-$$"
    info "Opening Chromium to renew '$_name' (filename never changes)..."
    CHROME_PATH="$_chrome" DEEPSEEK_AUTH_PATH="$TMP_PREFIX.tmp" node "$REPO_ROOT/scripts/deepseek_chrome_auth.js"
    _c=$?
    if [ $_c -ne 0 ]; then
        die "login incomplete (exit $_c) — '$_name' left untouched"
    fi
    info "Probing fresh credentials..."
    probe_or_die "$TMP_PREFIX.tmp" "probe says DEAD — '$_name' left untouched"
    install_staged "$TMP_PREFIX.tmp" "$_dest"
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
        _suffix=$(printf '%s' "$_b" | sed "s|^.*$_base||")
        mv "$_b" "$AUTH_DIR/$_base$_suffix"
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
        _suffix=$(printf '%s' "$_b" | sed "s|^.*$_old||")
        mv "$_b" "$AUTH_DIR/$_new$_suffix"
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
    # cmd_check_one <name> -> prints "<name>: <verdict>"; exit 0/1
    valid_name "$1" || die "bad name '$1'"
    _dest=$(name_to_file "$1")
    [ -f "$_dest" ] || die "no such account: $1"
    if _out=$(probe_file "$_dest"); then _code=0; else _code=$?; fi
    printf '%s: %s\n' "$1" "$_out"
    return $_code
}
cmd_check() {
    _target=${1:-}
    if [ -z "$_target" ] || [ "$_target" = "all" ]; then
        _fail=0 _i=0
        for _f in "$AUTH_DIR"/*.json; do
            [ -e "$_f" ] || continue
            case $_f in *.bak|*.bak-*) continue;; esac
            _i=$((_i + 1))
            _name=$(basename "$_f" .json)
            _out=$(probe_file "$_f") || _fail=1
            printf 'account_%d %s: %s\n' "$_i" "$_name" "$_out"
        done
        [ "$_i" -gt 0 ] || die "no accounts in $AUTH_DIR"
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
    DEEPSEEK_AUTH_DIR="$AUTH_DIR" node "$REPO_ROOT/scripts/doctor.js"
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
        check) cmd_check "${2:-all}" ;;
        import) cmd_import "${2:-}" ;;
        doctor) cmd_doctor ;;
        restart) restart_service ;;
        -h|--help|help) usage ;;
        *) usage ;;
    esac
}
main "$@"
