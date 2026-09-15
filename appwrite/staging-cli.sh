#!/usr/bin/env bash
# staging-cli.sh — run Appwrite CLI commands against the STAGING project only.
#
# Usage: ./staging-cli.sh <appwrite-cli-args...>
# Example: ./staging-cli.sh push functions --function-id 69341ffa001a4ebd28c2
#
# WHY THIS IS NOT A SIMPLE ENV WRAPPER
#
# This script used to export APPWRITE_ENDPOINT / APPWRITE_PROJECT / APPWRITE_KEY and
# assume the CLI would honour them. It does not. Appwrite CLI v22 reads no such
# variables — the only APPWRITE_* names in the bundle are two OAuth login feature
# flags — and it resolves the target project from appwrite.config.json AHEAD of
# anything global:
#
#     const project = localConfig.getProject().projectId
#       ? localConfig.getProject().projectId
#       : globalConfig.getProject();
#
# The committed config carries the PRODUCTION project id, so the old wrapper printed
# a reassuring "STAGING" banner and then talked to production. Every command ever run
# through it went to prod.
#
# The config file is therefore the only lever that works. This script swaps the
# project id in place for the duration of one command and restores it on exit, and
# refuses to start if it finds the config already swapped (an earlier run killed
# before its trap could fire).
#
# The API key is the same story: the CLI reads it from ~/.appwrite/prefs.json, not
# the environment, so that file is driven and restored too.

set -euo pipefail

STAGING_PROJECT_ID="6a0ad92e0001d5e515ce"
STAGING_ENDPOINT="https://nyc.cloud.appwrite.io/v1"
PROD_PROJECT_ID="691d4a54003b21bf0136"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/appwrite.config.json"
PREFS="$HOME/.appwrite/prefs.json"
LOCK="${TMPDIR:-/tmp}/samplefinder-staging-cli.lock"

die() { echo "ERROR: $*" >&2; exit 1; }

[ $# -gt 0 ] || die "no command given. Example: $0 push functions --function-id <id>"
[ -f "$CONFIG" ] || die "config not found at $CONFIG"

# `push tables` / `push collections` rewrite live columns from the committed config
# and ignore --id, which shrinks and enum-ifies attributes on whatever project they
# land on. Staging is still real data. Create or alter columns in the console instead.
if [ "${1:-}" = "push" ] && [ "${ALLOW_DESTRUCTIVE_SCHEMA_PUSH:-}" != "yes" ]; then
  reason=""
  case "${2:-}" in
    tables|collections) reason="'push $2' rewrites every column in the config" ;;
    "") reason="a bare 'push' prompts for resources, and tables can be picked" ;;
  esac
  case " $* " in
    *" --all "*) reason="'push --all' sweeps in tables regardless of subcommand" ;;
  esac
  [ -z "$reason" ] || die \
"refusing: $reason.
       CLI v22 ignores --id here, so it shrinks attribute sizes and re-enum-ifies
       values on whatever project it lands on — staging included. Make schema
       changes in the Appwrite console. To override deliberately:
           ALLOW_DESTRUCTIVE_SCHEMA_PUSH=yes $0 $*"
fi

[ -n "${APPWRITE_STAGING_API_KEY:-}" ] || die \
"APPWRITE_STAGING_API_KEY is not set. Run: source \"\$HOME/.samplefinder-staging.env\""

# Defense-in-depth: refuse if the prod project id is referenced anywhere in the env.
if env | grep -qF "$PROD_PROJECT_ID"; then
  die "production project id '$PROD_PROJECT_ID' is present in the shell env. Unset it first."
fi

# The config must be in its normal, committed state before we touch it. If it already
# names staging, a previous run died between the swap and its restore — restoring from
# a backup of an already-swapped file would make the damage permanent.
grep -qF "\"projectId\": \"$PROD_PROJECT_ID\"" "$CONFIG" || die \
"$CONFIG does not carry the expected production project id.
       An earlier run may have been killed mid-swap. Restore it before retrying:
           git -C \"$SCRIPT_DIR/..\" checkout -- appwrite/appwrite.config.json"

# Serialise runs: two concurrent swaps would race, and the first restore would hand the
# second command a config pointing somewhere it did not intend.
mkdir "$LOCK" 2>/dev/null || die "another staging-cli.sh run holds $LOCK. Wait, or remove it if stale."
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM   # replaced by restore() once backups exist

BACKUP_DIR="$(mktemp -d)"
chmod 700 "$BACKUP_DIR"
cp "$CONFIG" "$BACKUP_DIR/appwrite.config.json"
HAD_PREFS=no
if [ -f "$PREFS" ]; then
  HAD_PREFS=yes
  cp "$PREFS" "$BACKUP_DIR/prefs.json"
fi

restore() {
  local rc=$?
  set +e
  cp "$BACKUP_DIR/appwrite.config.json" "$CONFIG"
  if grep -qF "\"projectId\": \"$PROD_PROJECT_ID\"" "$CONFIG"; then
    if [ "$HAD_PREFS" = yes ]; then
      cp "$BACKUP_DIR/prefs.json" "$PREFS"
    else
      rm -f "$PREFS"
    fi
    rm -rf "$BACKUP_DIR"
  else
    # Never delete the backup we could not verify against.
    echo "" >&2
    echo "CRITICAL: failed to restore $CONFIG to the production project id." >&2
    echo "          Good copies are in $BACKUP_DIR" >&2
    echo "          Fix with: git -C \"$SCRIPT_DIR/..\" checkout -- appwrite/appwrite.config.json" >&2
    rc=1
  fi
  rmdir "$LOCK" 2>/dev/null
  exit $rc
}
trap restore EXIT INT TERM

# Swap the single top-level projectId, leaving the rest of the file byte-identical.
sed "s|\"projectId\": \"$PROD_PROJECT_ID\"|\"projectId\": \"$STAGING_PROJECT_ID\"|" \
  "$CONFIG" > "$BACKUP_DIR/config.swapped"
[ "$(grep -cF "\"projectId\": \"$STAGING_PROJECT_ID\"" "$BACKUP_DIR/config.swapped")" = "1" ] \
  || die "swap produced an unexpected number of staging project ids"
if grep -qF "$PROD_PROJECT_ID" "$BACKUP_DIR/config.swapped"; then
  die "swapped config still references the production project id"
fi
cp "$BACKUP_DIR/config.swapped" "$CONFIG"

# The CLI takes its key and default project from prefs.json, not the environment.
appwrite client \
  --endpoint "$STAGING_ENDPOINT" \
  --project-id "$STAGING_PROJECT_ID" \
  --key "$APPWRITE_STAGING_API_KEY" >/dev/null

# Prove the credentials actually resolve to staging before running anything that writes.
curl -fsS -o /dev/null \
  -G "$STAGING_ENDPOINT/functions" --data-urlencode 'queries[]={"method":"limit","values":[1]}' \
  -H "X-Appwrite-Project: $STAGING_PROJECT_ID" \
  -H "X-Appwrite-Key: $APPWRITE_STAGING_API_KEY" \
  || die "staging pre-flight failed — the key does not authenticate against $STAGING_PROJECT_ID"

echo "→ appwrite (STAGING project $STAGING_PROJECT_ID, verified) $*"
cd "$SCRIPT_DIR"
appwrite "$@"
