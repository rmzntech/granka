#!/usr/bin/env bash
# Builds the Arch package and drops it into the local pacman repo (/srv/myapp-repo).
# No sudo needed: makepkg runs as the current user; installing is a separate step.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
STAGE="$ROOT/.build/arch"
NAME="granka-$VERSION"
# Canonical repo lives in /srv/myapp-repo (readable by pacman without
# traversing $HOME). GRANKA_REPO_DIR overrides for tests/other checkouts.
REPO="${GRANKA_REPO_DIR:-/srv/myapp-repo}"

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
# zstd -T6: многопоточно и в разы быстрее однопоточного gzip на слабом CPU;
# размер сопоставим. Старые .tar.gz больше не создаём.
tar -I 'zstd -T6 -19' -cf "$ROOT/packaging/arch/granka-$VERSION.tar.zst" -C "$STAGE" "$NAME"

echo "==> building package (makepkg)"
( cd "$ROOT/packaging/arch" && makepkg -f )

# makepkg names the artefact after pkgver AND pkgrel, and pkgrel changes on a
# rebuild of the same version — read the name instead of assuming "-1".
BUILT="$(ls -t "$ROOT/packaging/arch"/granka-"$VERSION"-*.pkg.tar.zst | head -1)"
BUILT_NAME="$(basename "$BUILT")"

# makepkg распаковывает tarball (~226 МБ с prod node_modules) в src/ и pkg/,
# но не чистит за собой: раньше там копились все версии (3.8 ГБ).
# После успешной сборки удаляем распакованные копии всех версий.
rm -rf "$ROOT/packaging/arch/src"/granka-* "$ROOT/packaging/arch/pkg"/granka "$ROOT/packaging/arch/pkg"/granka-*

echo "==> publishing to local repo $REPO"
mkdir -p "$REPO"
# Старый пакет в репозитории может принадлежать root (сборка через sudo) —
# cp не перезапишет root-owned файл. Удаляем его сначала (ACL на каталог позволяет).
# Only this exact artefact: a glob over pkgver would also delete the previous
# pkgrel, which is the rollback copy the repo is supposed to keep.
rm -f "$REPO/$BUILT_NAME"
cp "$BUILT" "$REPO/"
# Правило репозитория (/srv/myapp-repo/AGENTS.md): только две версии пакета
# и база, пересозданная с помощью repo-add из обоих файлов.
( cd "$REPO" && ls -t granka-*.pkg.tar.zst 2>/dev/null | tail -n +3 | xargs -r rm -f )
rm -f "$REPO"/myapp.db.tar.gz "$REPO"/myapp.files.tar.gz "$REPO"/*.old
( cd "$REPO" && repo-add -q myapp.db.tar.gz granka-*.pkg.tar.zst )
rm -rf "$STAGE"

# Старые артефакты в packaging/arch/ больше не нужны (они в репозитории),
# включая прежний формат tarball (.tar.gz) текущей версии.
# grep возвращает 1, когда удалять нечего; с pipefail это рвало сборку после
# успешной публикации пакета.
ls -t "$ROOT/packaging/arch"/granka-*.tar.* "$ROOT/packaging/arch"/granka-*.pkg.tar.* 2>/dev/null \
  | grep -v "granka-$VERSION.tar.zst" | grep -v "$BUILT_NAME" | xargs -r rm -f || true

echo
echo "package: $REPO/$BUILT_NAME"
ls -la "$REPO"
