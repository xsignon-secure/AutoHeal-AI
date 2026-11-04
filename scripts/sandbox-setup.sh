#!/usr/bin/env bash
# Prepares the test sandbox: a separate Linux user that runs your tests and
# every proposed fix, so they cannot read the AI key in AutoHeal's process.
#
#   MODE=auto|user|off PROJECT=<project folder> ACTION_PATH=<this action> scripts/sandbox-setup.sh
#
# Writes user=, home= and browsers= to $GITHUB_OUTPUT (or stdout). With
# MODE=auto it never fails the job: if something is missing it prints why and
# AutoHeal runs without the sandbox (the PR says so). MODE=user fails instead.
set -euo pipefail

MODE="${MODE:-auto}"
SB_USER="${SB_USER:-autoheal-sb}"
OUT="${GITHUB_OUTPUT:-/dev/stdout}"

skip() {
  if [ "$MODE" = "user" ]; then echo "::error::sandbox: $1"; exit 1; fi
  echo "::notice::AutoHeal sandbox off: $1"
  exit 0
}

[ "$MODE" = "off" ] && exit 0
[ "$(uname -s)" = "Linux" ] || skip "only Linux runners are supported"
sudo -n true 2>/dev/null || skip "needs passwordless sudo to create the sandbox user"
[ -n "${PROJECT:-}" ] && [ -d "$PROJECT" ] || skip "project folder not found"

if ! command -v setfacl >/dev/null 2>&1; then
  sudo -n apt-get install -y -qq acl >/dev/null 2>&1 || skip "setfacl is missing and the acl package could not be installed"
fi

if ! id "$SB_USER" >/dev/null 2>&1; then
  sudo -n useradd --create-home --shell /usr/sbin/nologin --user-group "$SB_USER" || skip "could not create the user $SB_USER"
fi
SB_HOME="$(getent passwd "$SB_USER" | cut -d: -f6)"
ME="$(id -un)"
[ "$SB_USER" != "$ME" ] || skip "the sandbox user must not be the runner user"

# Each ancestor of a granted folder needs search (x) permission, nothing more.
traverse() {
  local d
  d="$(dirname "$1")"
  while [ "$d" != "/" ]; do
    # Inside the project the sandbox already has rwX; don't narrow it.
    case "$d/" in "${PROJECT:-//}/"*) ;; *) sudo -n setfacl -m "u:$SB_USER:x" "$d" ;; esac
    d="$(dirname "$d")"
  done
}

PROJECT="$(cd "$PROJECT" && pwd -P)"
# The project: read and write for both users, including files created later.
traverse "$PROJECT"
sudo -n setfacl -R -m "u:$SB_USER:rwX,u:$ME:rwX" "$PROJECT"
sudo -n find "$PROJECT" -type d -exec setfacl -m "d:u:$SB_USER:rwX,d:u:$ME:rwX" {} +
# Git's own folder is read-only for the sandbox: AutoHeal runs git on this
# checkout later, and a test must not be able to change .git/config or hooks.
GITDIR="$(git -C "$PROJECT" rev-parse --absolute-git-dir 2>/dev/null || true)"
if [ -n "$GITDIR" ] && [ -d "$GITDIR" ]; then
  traverse "$GITDIR"
  sudo -n setfacl -R -m "u:$SB_USER:rX" "$GITDIR"
  sudo -n find "$GITDIR" -type d -exec setfacl -m "d:u:$SB_USER:rX" {} +
fi

# Read-only: the engine (this action), Node, and the browsers. Only granted
# when the sandbox user cannot read them already, and never on system folders.
as_sb() { sudo -n -u "$SB_USER" -- "$@" >/dev/null 2>&1; }
read_only() {
  [ -e "$1" ] || return 0
  local p
  p="$(cd "$1" && pwd -P)"
  case "$p" in /|/usr|/usr/*|/bin|/bin/*|/lib*|/etc|/etc/*|/opt|/home|/root|/var|/tmp) return 0 ;; esac
  traverse "$p"
  sudo -n setfacl -R -m "u:$SB_USER:rX" "$p"
}
NODE="$(command -v node)"
as_sb "$NODE" -e 0 || read_only "$(dirname "$(dirname "$NODE")")"
if [ -n "${ACTION_PATH:-}" ]; then
  as_sb test -r "$ACTION_PATH/dist/cli.js" || read_only "$ACTION_PATH"
fi
BROWSERS="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
if [ -d "$BROWSERS" ]; then as_sb ls "$BROWSERS" || read_only "$BROWSERS"; fi

# A quick check: the sandbox user can start Node and see the project.
as_sb "$NODE" -e "require('fs').accessSync(process.argv[1], 6)" "$PROJECT" \
  || skip "the sandbox user cannot reach the project"

{
  echo "user=$SB_USER"
  echo "home=$SB_HOME"
  if [ -d "$BROWSERS" ]; then echo "browsers=$(cd "$BROWSERS" && pwd -P)"; fi
} >> "$OUT"
echo "AutoHeal sandbox ready: tests run as $SB_USER"
