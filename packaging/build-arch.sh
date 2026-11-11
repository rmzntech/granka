#!/usr/bin/env bash
# Builds the Arch package and drops it into the local pacman repo (~/pacman-myapp).
# No sudo needed: makepkg runs as the current user; installing is a separate step.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
STAGE="$ROOT/.build/arch"
NAME="granka-$VERSION"
REPO="${GRANKA_REPO_DIR:-$HOME/pacman-myapp}"

# icons are generated from icons.svg when missing
if [ ! -f "$ROOT/build/icons/512x512.png" ]; then
  mkdir -p "$ROOT/build/icons"
  rsvg-convert -w 256  -h 256  "$ROOT/icons.svg" -o "$ROOT/build/icons/256x256.png"
  rsvg-convert -w 512  -h 512  "$ROOT/icons.svg" -o "$ROOT/build/icons/512x512.png"
  rsvg-convert -w 1024 -h 1024 "$ROOT/icons.svg" -o "$ROOT/build/icons/1024x1024.png"
  cp "$ROOT/build/icons/512x512.png" "$ROOT/build/icon.png"
fi

echo "==> staging $NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE/$NAME"

# sources needed at runtime
cp -r "$ROOT/electron" "$ROOT/renderer" "$ROOT/package.json" "$ROOT/package-lock.json" \
      "$ROOT/NOTICE.md" "$ROOT/README.md" "$STAGE/$NAME/"
mkdir -p "$STAGE/$NAME/build"
cp -r "$ROOT/build/icons" "$STAGE/$NAME/build/icons"
mkdir -p "$STAGE/$NAME/packaging/arch"
# only the packaging sources: never the previously built tarball or pkgdir
for f in PKGBUILD granka.desktop granka.sh granka.install; do
  [ -f "$ROOT/packaging/arch/$f" ] && cp "$ROOT/packaging/arch/$f" "$STAGE/$NAME/packaging/arch/"
done

# PKGBUILD pkgver must match package.json
sed -i "s/^pkgver=.*/pkgver=$VERSION/" "$ROOT/packaging/arch/PKGBUILD"

echo "==> installing production dependencies"
( cd "$STAGE/$NAME" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null )

echo "==> packing tarball"
tar -czf "$ROOT/packaging/arch/granka-$VERSION.tar.gz" -C "$STAGE" "$NAME"

echo "==> building package (makepkg)"
( cd "$ROOT/packaging/arch" && makepkg -f )

echo "==> publishing to local repo $REPO"
mkdir -p "$REPO"
cp "$ROOT/packaging/arch/"granka-"$VERSION"-*.pkg.tar.* "$REPO/"
( cd "$REPO" && repo-add -q myapp.db.tar.gz granka-"$VERSION"-*.pkg.tar.zst )
repo-add -n -q "$REPO/myapp.db.tar.gz" "$REPO/"granka-"$VERSION"-*.pkg.tar.zst 2>/dev/null || true

rm -f "$REPO"/*.old
rm -rf "$STAGE"

echo
echo "package: $REPO/granka-$VERSION-1-x86_64.pkg.tar.zst"
ls -la "$REPO"
