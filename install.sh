#!/usr/bin/env bash
# Установка мессенджера «Полное погружение» на сервер Ubuntu.
# Запуск: sudo bash install.sh ваш-домен.ru
set -euo pipefail
DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then echo "Укажите домен: sudo bash install.sh chat.example.ru"; exit 1; fi
PB_VERSION="0.40.4"
APP_DIR="/opt/pogruzhenie"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "→ Ставлю нужные утилиты"
apt-get update -qq && apt-get install -y -qq unzip curl >/dev/null

echo "→ Копирую файлы в $APP_DIR"
mkdir -p "$APP_DIR"
cp -r "$SRC_DIR/pb_public" "$SRC_DIR/pb_hooks" "$SRC_DIR/pb_migrations" "$APP_DIR/"
cd "$APP_DIR"

case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Неизвестная архитектура процессора: $(uname -m)"; exit 1 ;;
esac
if [ ! -x ./pocketbase ]; then
  echo "→ Скачиваю PocketBase $PB_VERSION"
  curl -fsSL -o pb.zip "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${ARCH}.zip"
  unzip -o -q pb.zip pocketbase && rm pb.zip
fi

echo "→ Создаю базу"
./pocketbase migrate up

echo
echo "Придумайте вход в панель администратора (это не аккаунт в чате):"
read -rp "  Email: " ADMIN_EMAIL
read -rsp "  Пароль (минимум 10 символов): " ADMIN_PASS; echo
./pocketbase superuser upsert "$ADMIN_EMAIL" "$ADMIN_PASS" >/dev/null

echo "→ Запускаю как службу"
cat > /etc/systemd/system/pogruzhenie.service <<UNIT
[Unit]
Description=Polnoe pogruzhenie messenger
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/pocketbase serve $DOMAIN
Restart=always
RestartSec=5
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now pogruzhenie >/dev/null
sleep 3
if systemctl is-active --quiet pogruzhenie; then
  echo "✓ Готово: https://$DOMAIN"
else
  echo "Служба не запустилась. Лог: journalctl -u pogruzhenie -n 50"; exit 1
fi
echo
echo "Дальше: откройте https://$DOMAIN, нажмите «Регистрация» и создайте свой аккаунт ПЕРВЫМ — вы станете преподавателем."
echo "Панель администратора: https://$DOMAIN/_/"
