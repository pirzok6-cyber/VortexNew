# Vortex Messenger Server

Локальный и облачный сервер для мессенджера Vortex с поддержкой переписки и звонков.

---

## 🚀 Деплой на Railway (рекомендуется)

Railway — бесплатная платформа, которая позволяет запустить этот сервер в облаке под доменом вида `your-app.up.railway.app`.

### Шаг 1 — Загрузи код на GitHub

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/ВАШ_ЮЗЕР/vortex-server.git
git push -u origin main
```

### Шаг 2 — Создай проект на Railway

1. Зайди на [railway.app](https://railway.app) → **New Project**
2. Выбери **Deploy from GitHub repo** → выбери `vortex-server`
3. Railway автоматически обнаружит Node.js и запустит сборку

### Шаг 3 — Добавь PostgreSQL

1. В проекте нажми **+ New** → **Database** → **Add PostgreSQL**
2. Railway сам пропишет `DATABASE_URL` в переменные окружения

### Шаг 4 — Настрой переменные окружения

В Railway: **Variables** → добавь:

| Переменная | Значение |
|---|---|
| `DB_PROVIDER` | `postgresql` |
| `JWT_SECRET` | (сгенерируй: `openssl rand -hex 32`) |
| `CORS_ORIGINS` | `https://ВАШ-ДОМЕН.up.railway.app` |
| `NODE_ENV` | `production` |
| `MAX_REGISTRATIONS_PER_IP` | `5` |

> `DATABASE_URL` Railway проставит сам при добавлении PostgreSQL.

### Шаг 5 — Домен

В Railway: **Settings** → **Networking** → **Generate Domain**  
Получишь адрес вида: `https://vortex-server-production.up.railway.app`

---

## 💻 Локальный запуск

### Требования

- **Node.js** 18+: https://nodejs.org/

### Windows

```bash
# Скопируй .env.example → .env и заполни
copy .env.example .env
start-server.bat
```

### Linux / Mac

```bash
cp .env.example .env
chmod +x start-server.sh
./start-server.sh
```

### Вручную

```bash
npm install
npx prisma generate
npx prisma db push
npm run build
npm start
```

---

## ⚙️ Переменные окружения

Смотри `.env.example` — там все параметры с описанием.

---

## 🗄️ База данных

| Среда | База данных | `DB_PROVIDER` |
|---|---|---|
| Локально | SQLite (файл `prisma/dev.db`) | `sqlite` |
| Railway | PostgreSQL (автоматически) | `postgresql` |

---

## 📡 Возможности

- ✅ Регистрация и авторизация (JWT)
- ✅ Личные и групповые чаты
- ✅ Голосовые и видеозвонки (WebRTC)
- ✅ Отправка файлов, изображений, голосовых
- ✅ Истории (24 часа)
- ✅ Реакции, упоминания, опросы
- ✅ E2EE шифрование (опционально)
- ✅ WebSocket (Socket.io)
