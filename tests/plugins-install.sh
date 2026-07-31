#!/usr/bin/env bash
# Verifies the plugin install shell: copy-path (rsync --delete removes stale
# files), cp fallback, and make-path — all into temp dirs, no sudo.
set -euo pipefail
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

# The exact shell the JS emits (SRC/DEST substituted in).
install_sh() {  # $1=SRC $2=DEST
  sh -c 'set -e; SRC="'"$1"'"; DEST="'"$2"'";
    if [ -f "$SRC/Makefile" ]; then make -C "$SRC" install;
    else mkdir -p "$DEST";
      if command -v rsync >/dev/null 2>&1; then rsync -a --delete "$SRC"/ "$DEST"/;
      else cp -a "$SRC"/. "$DEST"/; fi;
    fi'
}

# --- copy path (no Makefile): fresh files copied, stale file removed ---
mkdir -p "$WORK/src_copy/inflighttv/assets"
echo hi > "$WORK/src_copy/inflighttv/index.html"
echo x  > "$WORK/src_copy/inflighttv/assets/a.js"
DEST="$WORK/dest_copy/inflighttv"; mkdir -p "$DEST"
echo STALE > "$DEST/old-removed-file.js"          # must be deleted by --delete
install_sh "$WORK/src_copy/inflighttv" "$DEST"
test -f "$DEST/index.html"
test -f "$DEST/assets/a.js"
if command -v rsync >/dev/null 2>&1; then
  test ! -f "$DEST/old-removed-file.js" || { echo "FAIL: stale file survived"; exit 1; }
fi
echo "copy-path OK"

# --- cp fallback (rsync branch bypassed): dotfiles + subdirs copied ---
mkdir -p "$WORK/src_cp/manifest/sub"
echo a > "$WORK/src_cp/manifest/.hidden"
echo b > "$WORK/src_cp/manifest/sub/nested.txt"
DEST2="$WORK/dest_cp/manifest"; mkdir -p "$DEST2"
cp -a "$WORK/src_cp/manifest"/. "$DEST2"/
test -f "$DEST2/.hidden"
test -f "$DEST2/sub/nested.txt"
echo "cp-fallback OK"

# --- make path (Makefile present) ---
mkdir -p "$WORK/src_make/explorer"
cat > "$WORK/src_make/explorer/Makefile" <<'MK'
install:
	mkdir -p "$(WORK)/dest_make"
	echo installed > "$(WORK)/dest_make/marker"
MK
sh -c 'set -e; SRC="'"$WORK"'/src_make/explorer"; if [ -f "$SRC/Makefile" ]; then make -C "$SRC" install WORK="'"$WORK"'"; fi'
test -f "$WORK/dest_make/marker"
echo "make-path OK"
echo "plugins-install: OK"
