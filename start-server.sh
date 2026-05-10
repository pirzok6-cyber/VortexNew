#!/bin/bash
set -e
cd "$(dirname "$0")"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "             VORTEX MESSENGER SERVER v1.1"
echo "═══════════════════════════════════════════════════════"

if ! command -v node &> /dev/null; then
    echo "[ОШИБКА] Node.js не найден! https://nodejs.org/"
    exit 1
fi
echo "[INFO] Node.js: $(node --version)"

# Создаём .env если нет
if [ ! -f ".env" ]; then
    echo "[INFO] Создаётся .env из .env.example..."
    cp .env.example .env
    echo "[ВНИМАНИЕ] Отредактируйте .env перед запуском!"
    read -p "Нажмите Enter для продолжения..."
fi

if [ ! -d "node_modules" ]; then
    echo "[INFO] Первый запуск — npm install..."
    npm install
fi

echo "[INFO] Подготовка базы данных..."
npx prisma generate
npx prisma db push

echo "[INFO] Сборка TypeScript..."
npx tsc || { echo "[WARN] Сборка не удалась — стартую dev через tsx"; exec npx tsx src/index.ts; }

echo ""
echo "[INFO] Запуск сервера..."
exec node dist/index.js
