#!/usr/bin/env bash
# Removes the [alpha-local] repo: its section in /etc/pacman.conf and,
# optionally, the repository directory /srv/alpha-repo.
# Everything else (other repos, installed alpha packages) is left untouched.
# Usage: ./remove-alpha-repo.sh
set -euo pipefail

CONF=/etc/pacman.conf
REPO_DIR=/srv/alpha-repo

if grep -q "^\[alpha-local\]" "$CONF"; then
  echo "Удаляю секцию [alpha-local] из $CONF…"
  sudo sed -i '/^\[alpha-local\]/,/^Server = file:\/\/\/srv\/alpha-repo/d' "$CONF"
  # drop a now-empty comment line left above the section, if any
  sudo sed -i '/^# Local Alpha builds (created by scripts\/enable-local-repo.sh)$/d' "$CONF"
  echo "Секция удалена."
else
  echo "Секции [alpha-local] в $CONF нет."
fi

if [ -d "$REPO_DIR" ]; then
  read -r -p "Удалить каталог репозитория $REPO_DIR? [y/N] " answer
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    sudo rm -rf "$REPO_DIR"
    echo "Каталог $REPO_DIR удалён."
  else
    echo "Каталог оставлен: $REPO_DIR"
  fi
else
  echo "Каталога $REPO_DIR нет."
fi

echo "Обновляю список пакетов…"
sudo pacman -Sy
echo
echo "Готово. Установленные пакеты alpha не тронуты — удаляются отдельно: sudo pacman -Rns alpha"
