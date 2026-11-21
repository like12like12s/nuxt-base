#!/usr/bin/env bash
# Mirror the layer's components to the copy-based template dir used by non-Nuxt Vue projects.
# nuxt-base/app/components is the single source; ~/.dev-mem/templates/components is a verified mirror (cmp), like deploy-docker.sh.
#   scripts/sync-templates.sh          copy layer → templates
#   scripts/sync-templates.sh --check  exit 1 if any mirrored file differs (used by `npm run gate`)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
src="$here/app/components"
dst="${TEMPLATES_DIR:-$HOME/.dev-mem/templates/components}"
[ -d "$dst" ] || { echo "templates dir missing: $dst (skip)"; exit 0; }
rc=0
for f in "$dst"/*.vue; do
  n="$(basename "$f")"
  if [ ! -f "$src/$n" ]; then echo "template without layer source: $n"; rc=1; continue; fi
  if ! cmp -s "$src/$n" "$f"; then
    if [ "${1:-}" = "--check" ]; then echo "DRIFT: $n"; rc=1; else cp "$src/$n" "$f"; echo "synced $n"; fi
  fi
done
[ "${1:-}" = "--check" ] && [ $rc -eq 0 ] && echo "templates in sync with nuxt-base ($(ls "$dst"/*.vue | wc -l) files)"
exit $rc
