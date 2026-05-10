@echo off
chcp 65001 >nul
title Vortex Server

echo.
echo ═══════════════════════════════════════════════════════
echo              VORTEX MESSENGER SERVER v1.1
echo ═══════════════════════════════════════════════════════
echo.

:: Проверка Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ОШИБКА] Node.js не найден!
    echo Скачайте Node.js с https://nodejs.org/
    pause
    exit /b 1
)

echo [INFO] Node.js найден:
node --version

:: Переходим в папку сервера
cd /d "%~dp0"

:: Создаём .env если нет
if not exist ".env" (
    echo [INFO] Создаётся .env из .env.example...
    copy .env.example .env
    echo [ВНИМАНИЕ] Отредактируйте .env перед запуском!
    pause
)

:: Проверяем наличие node_modules
if not exist "node_modules\" (
    echo.
    echo [INFO] Первый запуск — установка зависимостей...
    npm install
    if %ERRORLEVEL% NEQ 0 (
        echo [ОШИБКА] Не удалось установить зависимости
        pause
        exit /b 1
    )
)

:: Генерируем Prisma клиент и применяем миграции
echo [INFO] Подготовка базы данных...
npx prisma generate
npx prisma db push

:: Собираем TypeScript
echo [INFO] Сборка TypeScript...
npx tsc
if %ERRORLEVEL% NEQ 0 (
    echo [ОШИБКА] Сборка не удалась — запускаю в dev-режиме...
    npx tsx src/index.ts
    pause
    exit /b 1
)

echo.
echo [INFO] Запуск сервера...
echo.
node dist/index.js

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ОШИБКА] Сервер завершился с ошибкой
    pause
)
