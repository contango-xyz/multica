#!/bin/sh
# Fork-only: copy a contango:build output to the admin box, which forwards it
# to ops (publish-desktop). Metadata goes last so updaters never see a
# version whose ZIP is missing.
set -eu
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$HERE/dist"
ENVFILE="$HERE/.env.contango.local"

# Read only CONTANGO_ADMIN_SSH from the env file (never source the whole file).
if [ -z "${CONTANGO_ADMIN_SSH:-}" ] && [ -f "$ENVFILE" ]; then
  CONTANGO_ADMIN_SSH="$(grep -E '^[[:space:]]*(export[[:space:]]+)?CONTANGO_ADMIN_SSH=' "$ENVFILE" | tail -n 1 \
    | sed -E 's/^[^=]*=//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')"
fi
ADMIN="${CONTANGO_ADMIN_SSH:?set CONTANGO_ADMIN_SSH in .env.contango.local}"

# Publish exactly the version named in the metadata file, not stale builds.
[ -f "$DIST/contango-mac.yml" ] || { echo "missing $DIST/contango-mac.yml" >&2; exit 1; }
VERSION="$(sed -n -E 's/^version:[[:space:]]*"?([^"[:space:]]+)"?.*$/\1/p' "$DIST/contango-mac.yml" | head -n 1)"
[ -n "$VERSION" ] || { echo "no version in contango-mac.yml" >&2; exit 1; }
BASE="$DIST/multica-desktop-$VERSION-mac-arm64"
for f in "$BASE.dmg" "$BASE.zip" "$BASE.zip.blockmap" "$BASE.dmg.blockmap"; do
  [ -f "$f" ] || { echo "missing artifact: $f" >&2; exit 1; }
done

STAGE="desktop-release-$(date -u +%Y%m%dT%H%M%SZ)"
# shellcheck disable=SC2029  # STAGE is meant to expand locally
ssh "$ADMIN" "mkdir -p ~/$STAGE"
scp "$BASE.dmg" "$BASE.dmg.blockmap" "$BASE.zip" "$BASE.zip.blockmap" "$ADMIN:~/$STAGE/"
scp "$DIST/contango-mac.yml" "$ADMIN:~/$STAGE/"
# shellcheck disable=SC2029
# Login shell: publish-desktop lives in ~/.local/bin, which a non-interactive
# ssh command's PATH does not include.
ssh "$ADMIN" "bash -lc 'publish-desktop ~/$STAGE'"
