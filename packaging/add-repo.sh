#!/usr/bin/env bash
# Adds the local granka pacman repo (/srv/myapp-repo) to /etc/pacman.conf.
# Idempotent: safe to run repeatedly. Requires sudo.
# Usage: ./add-repo.sh
set -euo pipefail

REPO_DIR="/srv/myapp-repo"
SECTION="[myapp]"

if grep -q "^\[myapp\]" /etc/pacman.conf; then
  echo "Репозиторий [myapp] уже добавлен в /etc/pacman.conf"
else
  echo "Добавляю [myapp] в /etc/pacman.conf…"
  printf '\n%s\nSigLevel = Optional TrustAll\nServer = file://%s\n' "$SECTION" "$REPO_DIR" \
    | sudo tee -a /etc/pacman.conf >/dev/null
  echo "Добавлено."
fi

echo "Обновляю список пакетов…"
sudo pacman -Sy
echo
echo "Готово. Установка: sudo pacman -S granka"
