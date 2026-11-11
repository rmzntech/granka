#!/usr/bin/env bash
# Устанавливает собранный пакет и (по желанию) подключает локальный репозиторий myapp.
# Требует sudo — запускать вручную.
set -euo pipefail

REPO="${GRANKA_REPO_DIR:-$HOME/pacman-myapp}"
PKG="$(ls -1 "$REPO"/granka-*.pkg.tar.zst 2>/dev/null | tail -1)"
[ -n "$PKG" ] || { echo "Пакет не найден в $REPO — сначала запустите packaging/build-arch.sh"; exit 1; }

echo "==> установка $PKG"
sudo pacman -U --noconfirm "$PKG"

cat <<TIP

Пакет установлен. Проверка:
  pacman -Q granka
  granka

Хотите обновлять через pacman из локального репозитория myapp? Добавьте в /etc/pacman.conf:

[myapp]
SigLevel = Optional TrustAll
Server = file://$REPO

затем:
  sudo pacman -Sy

(если репозиторий переедет в другое место — поменяйте путь в Server)
TIP
