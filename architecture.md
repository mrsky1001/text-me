# Text-Me: Архитектура образовательного мессенджера

Полный технический документ: стек, схема БД, архитектура обработки сообщений через AI, User Flow, и **пошаговый план разработки в виде промтов для нейросети**.

---

## 1. Технологический стек

### Frontend (Web)
| Слой | Технология | Обоснование |
|------|-----------|-------------|
| Язык | **Vanilla JS (ES Modules)** | Минимум зависимостей, полный контроль над DOM, быстрый старт без бандлера |
| Стили | **CSS3 + CSS Custom Properties** | Темная/светлая тема через `--var`, плавные анимации без фреймворков |
| Реалтайм | **Socket.io Client** | Авто-реконнект, fallback на polling, совместимость с серверной частью |
| Шаблоны | **`<template>` + `cloneNode`** | Нативный браузерный шаблонизатор, без Virtual DOM overhead |

> **💡 Заметка о мобильных платформах:**
> Vanilla JS + CSS — идеальный старт для MVP. Миграция на React/Vue возможна позже, когда MVP подтвердит гипотезу. Для мобильных платформ (Android/iOS) в будущем используем **Flutter** — единая кодовая база, нативная производительность, готовые виджеты для мессенджер-UI.

### Backend
| Слой | Технология | Обоснование |
|------|-----------|-------------|
| Сервер | **Node.js + Fastify** | Асинхронность «из коробки», JSON Schema валидация, в 2-3× быстрее Express |
| WebSocket | **Socket.io** (поверх Fastify) | Комнаты (rooms), авто-реконнект, namespace isolation |
| AI Service | **LanguageTool API** → (будущее) **Локальная LLM** → **Нейросеть РФ** | Стратегия адаптера: начинаем с LT, затем подменяем провайдера без изменения кода |
| Кэш | **In-memory Map** (MVP) → **Redis** (scale) | Кэширование частых фраз для мгновенного ответа |

### Database
| Компонент | Технология | Обоснование |
|-----------|-----------|-------------|
| СУБД | **PostgreSQL (Supabase)** | JSONB для `correction_data`, полнотекстовый поиск, hosted free-tier |
| Подключение | **Supabase Connection Pooler** (PgBouncer) | Экономия соединений, обязательно для free-tier (макс ~60 соединений) |
| Драйвер | **pg** (node-postgres) | Лёгкий, без ORM overhead, prepared statements |
| Хранение файлов | **Supabase Storage** | Только изображения до 10 МБ, бакет с auto-cleanup |
| Миграции | **SQL файлы** (ручные) | Контроль, простота, нет лишних зависимостей |

### Деплой (MVP)
| Сервис | Назначение | Тариф |
|--------|-----------|-------|
| **Render.com** | Node.js бэкенд (Web Service) | **Free** (750 ч/мес, автосон через 15 мин) |
| **Supabase** | PostgreSQL база данных | **Free** (500 МБ БД, 1 ГБ file storage, 50K записей Auth) |

> [!CAUTION]
> **Ограничения бесплатных тарифов — критически важно:**
> - **Render Free**: сервер засыпает через ~15 мин неактивности, холодный старт ~30 сек. WebSocket соединения разрываются при засыпании.
> - **Supabase Free**: лимит 500 МБ на БД, 1 ГБ file storage, паузятся проекты через 7 дней неактивности.
> - **Все API запросы и SQL должны быть максимально оптимизированы:** минимальные payload, пагинация, индексы, prepared statements, сжатие JSON.
> - **Обязательна стратегия очистки данных** для предотвращения роста БД (см. раздел «Жизненный цикл данных»).

### Ограничения вложений (MVP)
| Тип | Поддержка | Макс. размер | Хранение |
|-----|-----------|-------------|----------|
| **Изображения** (JPEG, PNG, WebP) | ✅ Да | **10 МБ** | Supabase Storage → авто-удаление через 3–7 дней |
| Файлы, документы | ❌ Нет (отложено) | — | — |
| Аудио, видео | ❌ Нет (отложено) | — | — |

---

## 2. Схема базы данных

```sql
-- ========================================
-- ПОЛЬЗОВАТЕЛИ
-- ========================================
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username    VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100),
    avatar_url  TEXT,
    native_lang VARCHAR(5) DEFAULT 'ru',
    target_lang VARCHAR(5) DEFAULT 'en',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ========================================
-- ЧАТЫ
-- ========================================
CREATE TABLE chats (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(100),
    is_group    BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE chat_members (
    chat_id     UUID REFERENCES chats(id) ON DELETE CASCADE,
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    joined_at   TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (chat_id, user_id)
);

-- ========================================
-- ДВУХУРОВНЕВЫЕ СООБЩЕНИЯ
-- ========================================
CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id         UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id       UUID NOT NULL REFERENCES users(id),
    original_text   TEXT NOT NULL,
    check_status    VARCHAR(20) DEFAULT 'pending',
    -- 'pending' | 'checking' | 'done' | 'skipped' | 'error'
    corrected_text  TEXT,
    has_errors      BOOLEAN DEFAULT FALSE,
    correction_data JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_chat_id ON messages(chat_id, created_at DESC);
CREATE INDEX idx_messages_sender  ON messages(sender_id);
CREATE INDEX idx_messages_cleanup ON messages(created_at)
    WHERE created_at < NOW() - INTERVAL '3 days'; -- для быстрой очистки

-- ========================================
-- ИЗОБРАЖЕНИЯ В СООБЩЕНИЯХ (макс 10 МБ)
-- ========================================
CREATE TABLE message_images (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    storage_path TEXT NOT NULL,            -- путь в Supabase Storage
    file_size   INTEGER NOT NULL,          -- размер в байтах (макс 10485760)
    mime_type   VARCHAR(20) NOT NULL,      -- image/jpeg, image/png, image/webp
    width       INTEGER,
    height      INTEGER,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    expires_at  TIMESTAMPTZ DEFAULT NOW() + INTERVAL '3 days'  -- TTL
);

CREATE INDEX idx_images_expires ON message_images(expires_at);
CREATE INDEX idx_images_message ON message_images(message_id);

-- ========================================
-- АВТОМАТИЧЕСКАЯ ОЧИСТКА ДАННЫХ
-- ========================================

-- Функция удаления старых сообщений (вызывается по cron)
CREATE OR REPLACE FUNCTION cleanup_old_messages(retention_days INTEGER DEFAULT 3)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM messages
    WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Функция удаления просроченных изображений
CREATE OR REPLACE FUNCTION cleanup_expired_images()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- Сначала нужно удалить файлы из Supabase Storage (через Edge Function)
    -- Здесь удаляем только записи из БД
    DELETE FROM message_images
    WHERE expires_at < NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Cron-задачи (Supabase pg_cron расширение)
-- Очистка сообщений старше 3 дней — каждый час
SELECT cron.schedule('cleanup-messages', '0 * * * *', 'SELECT cleanup_old_messages(3)');
-- Очистка просроченных изображений — каждые 30 мин
SELECT cron.schedule('cleanup-images', '*/30 * * * *', 'SELECT cleanup_expired_images()');
```

### Структура `correction_data` (JSONB)

```json
{
  "errors": [
    {
      "original": "I wants to go in cinema",
      "corrected": "I want to go to the cinema",
      "offset": 2,
      "length": 5,
      "rule": "SUBJECT_VERB_AGREEMENT",
      "category": "Grammar",
      "explanation": "After 'I', use the base form: 'want' instead of 'wants'."
    }
  ],
  "detected_language": "en",
  "provider": "languagetool",
  "checked_at": "2026-03-22T10:00:00Z"
}
```

---

## 2.1 Жизненный цикл данных (Data Retention)

> [!IMPORTANT]
> База данных на Supabase Free Tier ограничена **500 МБ**. Без автоочистки БД заполнится за несколько недель активного использования.

### Политика хранения

| Тип данных | Срок хранения | Механизм удаления | Настраиваемость |
|----------|---------|------------|---------------|
| **Сообщения** (`messages`) | **3 дня** | `pg_cron` + SQL функция `cleanup_old_messages()` | `RETENTION_DAYS_MESSAGES` в `.env` |
| **Изображения** (записи БД) | **3–7 дней** (по `expires_at`) | `pg_cron` + `cleanup_expired_images()` | `expires_at` при загрузке |
| **Файлы изображений** (Supabase Storage) | **3–7 дней** | Edge Function / серверный cron | Синхронно с БД |
| **Пользователи** (`users`) | Бессрочно | — | — |
| **Чаты** (`chats`, `chat_members`) | Бессрочно | — | — |

### Механизм очистки

```
[БД: pg_cron] ── каждый час ──→ cleanup_old_messages(3)
                 ── каждые 30 мин → cleanup_expired_images()
                                            │
                                            ▼
[Сервер: cron fallback] ─→ Запрос к БД на удаление
                           ─→ Supabase Storage API: удаление файлов по storage_path
```

**Очистка файлов из Supabase Storage:**
- `pg_cron` удаляет только записи в БД, но **не файлы** из Storage
- Файлы удаляются через **серверный cron** (`node-cron`) на Render: раз в час запрашивает просроченные `storage_path` → вызывает Supabase Storage API `deleteFile()`
- Опционально: Supabase Edge Function как резерв

---

## 3. Архитектура обработки сообщений через AI

### Конвейер обработки (Pipeline)

```
Пользователь                 Frontend                WS Server             DB           AI Service       Кэш
    |                           |                        |                  |                |             |
    |--- набирает текст ------->|                        |                  |                |             |
    |                           |--- send_message ------>|                  |                |             |
    |                           |                        |--- INSERT ------>|                |             |
    |                           |<--- msg_ack -----------|                  |                |             |
    |                           |                        |--- new_msg ---->получатель        |             |
    |                           |                        |                  |                |             |
    |                           |                        |--- check cache ->|                |---get()--->|
    |                           |                        |                  |  (если нет)--->|             |
    |                           |                        |                  |                |             |
    |                           |                        |<-- result -------|<--- analyze() -|             |
    |                           |                        |--- UPDATE ------>|                |---set()--->|
    |                           |<--- msg_checked -------|                  |                |             |
    |<-- Рендерит sub-bubble ---|                        |                  |                |             |
```

### Стратегия «без задержек»

1. **Optimistic UI** — сообщение появляется в чате мгновенно, ещё до сохранения в БД
2. **Fire-and-forget AI** — проверка запускается параллельно, не блокирует доставку
3. **Кэш типовых фраз** — `Map<hash(text), AnalysisResult>` в памиаты, TTL 1 час
4. **Graceful degradation** — если AI-сервис недоступен, сообщение просто не получает плашку

### Паттерн Адаптера (Смена AI провайдера)

```
TextAnalyzer (интерфейс)
  ├── LanguageToolAnalyzer    ← MVP (сейчас)
  ├── LocalLLMAnalyzer        ← Этап 2 (своя LLM на PC)
  └── RuNetworkAnalyzer       ← Этап 3 (нейросеть РФ)
```

Все адаптеры реализуют единый метод:
```js
async analyze(text) → { original, corrected, has_errors, errors[], detected_language }
```

---

## 4. User Flow: Структура экранов

### Карта экранов

```
[Вход] → [Список чатов] → [Окно чата] → [Набор + Smart Hint] → [Отправка + Optimistic UI]
                                                                         ↓
                                                            [AI проверка (асинхр.)]
                                                                         ↓
                                                          [Двухуровневый бабл]
                                                                         ↓
                                                          [Bottom Sheet разбор] → [Назад в чат]
```

### Детальный User Flow

#### Экран 1: Вход (Псевдо-авторизация)
- Минимальная форма: поле `username` + кнопка «Войти»
- Сохранение в `localStorage`, без пароля (MVP)
- Автовход при повторном открытии

#### Экран 2: Список чатов (Telegram-style)
- Верхняя панель: логотип + поиск
- Список карточек: аватар, имя, последнее сообщение, время
- FAB кнопка «+» для создания нового чата
- Сортировка по дате последнего сообщения

#### Экран 3: Окно диалога
- **Header**: имя собеседника, статус онлайн, кнопка назад
- **Область сообщений**: баблы (мои справа, чужие слева), автоскролл
- **Smart Hint панель**: узкая полоса НАД полем ввода
  - Пусто → «AI ассистент готов»
  - При наборе → подсказка в реальном времени
  - Клик по подсказке → замена текста в поле ввода
- **Поле ввода**: textarea + иконка разбора + кнопка отправки

#### Двухуровневый бабл (Bubble)
```
┌──────────────────────────────┐
│  Мы пошли в кино вчера       │  ← Оригинал (основной фон)
├──────────────────────────────┤  ← Тонкая линия
│  We went to the cinema       │  ← Эталон (бледный фон,
│  yesterday              💡   │     курсив, иконка разбора)
└──────────────────────────────┘
```

#### Bottom Sheet (Грамматический разбор)
- Вызов: клик по 💡 на эталонной строке
- Выезжает снизу, перекрывает ~50% экрана
- Содержимое:
  - **Фраза**: `"We went to the cinema yesterday"`
  - **Время**: Past Simple
  - **Объяснение**: `"Действие завершено в прошлом (yesterday). Глагол go — неправильный, 2-я форма — went."`
  - **Список ошибок**: `[Ошибка] → [Правильно]` + пояснение
- Закрытие: свайп вниз или клик по оверлею

---

## 5. Структура файлов проекта

```
text-me/
├── src/
│   ├── server.js
│   ├── db/
│   │   ├── index.js
│   │   └── migrations/
│   │       └── 001_init.sql
│   ├── routes/
│   │   ├── auth.js
│   │   ├── chats.js
│   │   ├── messages.js
│   │   └── images.js              ← загрузка изображений (10 МБ макс)
│   ├── services/
│   │   ├── textAnalyzer.js
│   │   ├── languageToolAnalyzer.js
│   │   ├── phraseCache.js
│   │   ├── cleanupService.js      ← автоудаление сообщений/изображений
│   │   └── supabaseClient.js      ← клиент Supabase Storage
│   └── ws/
│       └── socketManager.js
├── public/
│   ├── index.html
│   ├── styles.css
│   └── js/
│       ├── app.js
│       ├── api.js
│       ├── ws.js
│       ├── chatList.js
│       ├── chatView.js
│       ├── smartHint.js
│       └── bottomSheet.js
├── .env
└── package.json
```

---

## 6. Пошаговый план разработки (Промты для нейросети)

> **⚠️ ВАЖНО:** Каждый этап ниже — **самодостаточный промт**, который можно скопировать и передать нейросети для реализации. Этапы идут строго последовательно: каждый следующий зависит от предыдущего.

> [!CAUTION]
> **КОНТЕКСТ ДЕПЛОЯ — добавлять в КАЖДЫЙ промт перед основным текстом:**
>
> *«Бэкенд развёрнут на **Render.com Free Tier** (холодный старт, ограниченные ресурсы), база данных — **Supabase Free Tier** (PostgreSQL, лимит 500 МБ на БД, 1 ГБ file storage). Максимально оптимизируй все SQL запросы, используй индексы, минимальные payload в API, пагинацию, prepared statements. База не должна расти бесконтрольно.»*

---

### ЭТАП 1: Инициализация проекта и бэкенд-скелет

**Промт для нейросети:**

> Создай Node.js проект с Fastify для бэкенда мессенджера. **Деплой: Render.com Free + Supabase Free (PostgreSQL + Storage).** Все SQL-запросы и API должны быть максимально оптимизированы. Структура:
> 
> 1. Инициализируй `package.json` с зависимостями: `fastify`, `@fastify/cors`, `@fastify/static`, `@fastify/multipart`, `dotenv`, `pg`, `@supabase/supabase-js`, `node-cron`.
> 2. Создай файл `src/server.js` — точка входа Fastify с поддержкой CORS и раздачей статики из папки `public/`.
> 3. Создай модуль `src/db/index.js` — пул подключений PostgreSQL через `pg.Pool` к **Supabase Connection Pooler** (PgBouncer). Настройки из `.env` (`DATABASE_URL` — строка подключения Supabase pooler). Используй `max: 5` для экономии соединений на free-tier.
> 4. Создай файл миграции `src/db/migrations/001_init.sql` с таблицами:
>    - `users` (id UUID PK, username VARCHAR(50) UNIQUE, display_name VARCHAR(100), native_lang VARCHAR(5) DEFAULT 'ru', target_lang VARCHAR(5) DEFAULT 'en', created_at TIMESTAMPTZ)
>    - `chats` (id UUID PK, name VARCHAR(100), is_group BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ)
>    - `chat_members` (chat_id UUID FK, user_id UUID FK, joined_at TIMESTAMPTZ, PK(chat_id, user_id))
>    - `messages` (id UUID PK, chat_id UUID FK, sender_id UUID FK, original_text TEXT NOT NULL, check_status VARCHAR(20) DEFAULT 'pending', corrected_text TEXT, has_errors BOOLEAN DEFAULT FALSE, correction_data JSONB, created_at TIMESTAMPTZ)
>    - `message_images` (id UUID PK, message_id UUID FK ON DELETE CASCADE, storage_path TEXT NOT NULL, file_size INTEGER NOT NULL, mime_type VARCHAR(20) NOT NULL, width INTEGER, height INTEGER, created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '3 days')
>    - Индексы: `messages(chat_id, created_at DESC)`, `messages(sender_id)`, `messages(created_at)` (для cleanup), `message_images(expires_at)`, `message_images(message_id)`.
>    - SQL-функции `cleanup_old_messages(retention_days INTEGER DEFAULT 3)` и `cleanup_expired_images()` для автоудаления. Cron-задачи через `pg_cron`: `cleanup-messages` каждый час, `cleanup-images` каждые 30 мин.
> 5. Создай `src/services/cleanupService.js` — серверный fallback cron через `node-cron`:
>    - Каждый час: вызывает `cleanup_old_messages()` в БД.
>    - Каждый час: запрашивает `message_images WHERE expires_at < NOW()`, удаляет файлы из Supabase Storage API, затем удаляет записи из БД.
> 6. Создай REST роуты:
>    - `POST /api/users` — создание/вход по username (upsert), возвращает объект пользователя. **Только нужные поля в SELECT.**
>    - `POST /api/chats` — создание чата между двумя пользователями (принимает `user_ids[]`).
>    - `GET /api/chats?user_id=` — список чатов пользователя с последним сообщением. **Один оптимизированный SQL с JOIN + LIMIT.**
>    - `GET /api/chats/:chatId/messages` — история сообщений чата (**cursor-пагинация через `before`, LIMIT 50**).
>    - `POST /api/chats/:chatId/images` — загрузка изображения (макс 10 МБ, только JPEG/PNG/WebP). Сохраняет в Supabase Storage bucket `chat-images`, создаёт запись в `message_images`.
> 7. Создай `.env.example` с шаблоном: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `RETENTION_DAYS_MESSAGES=3`, `RETENTION_DAYS_IMAGES=3`, `PORT`.
> 8. Добавь npm скрипты: `start`, `dev` (с nodemon), `db:migrate` (выполнение SQL файлов).
>
> Файловая структура: `src/server.js`, `src/db/index.js`, `src/db/migrations/001_init.sql`, `src/routes/auth.js`, `src/routes/chats.js`, `src/routes/messages.js`, `src/routes/images.js`, `src/services/cleanupService.js`. Код должен быть чистым, с комментариями на русском. **Все SQL — prepared statements, SELECT только нужных полей, без `SELECT *`.**

---

### ЭТАП 2: WebSocket — реалтайм обмен сообщениями

**Промт для нейросети:**

> Добавь реалтайм обмен сообщениями через WebSocket к существующему Fastify серверу. Используй `socket.io` + `fastify-socket.io`.
>
> 1. Установи `socket.io` и `fastify-socket.io`.
> 2. Создай модуль `src/ws/socketManager.js`:
>    - При подключении клиент передаёт свой `user_id` в handshake query.
>    - Сохраняй маппинг `user_id → socket.id` в Map для отслеживания онлайн-статусов.
>    - Обработчик `join_chat`: клиент подписывается на комнату `chat:{chatId}`.
>    - Обработчик `send_message`: принимает `{ chat_id, text, local_id }`.
>      - Сохраняет сообщение в БД (поле `original_text`), `check_status = 'pending'`.
>      - Отправляет отправителю `msg_ack` с `{ local_id, msg_id, status: 'sent' }`.
>      - Отправляет всем в комнате (кроме отправителя) `new_msg` с полным объектом сообщения.
>    - Обработчик `typing`: при наборе текста отправляет `user_typing` всем в комнате.
>    - Обработчик `disconnect`: удаляет из маппинга, рассылает статус offline.
> 3. Подключи `socketManager` к серверу в `src/server.js`.
>
> Важно: сообщение должно доставляться мгновенно (Optimistic UI pattern). Проверка AI будет добавлена позднее как асинхронный шаг ПОСЛЕ доставки.

---

### ЭТАП 3: Фронтенд — Telegram-style верстка

**Промт для нейросети:**

> Создай фронтенд для мессенджера в стиле Telegram. Чистый HTML + CSS + Vanilla JS (ES Modules). Никаких фреймворков.
>
> **Файл `public/index.html`:**
> - Единый HTML файл (SPA). Содержит два основных блока:
>   - `.sidebar` — список чатов (левая панель на десктопе, полный экран на мобил).
>   - `.chat-view` — окно диалога (правая панель на десктопе, полный экран на мобил).
> - Блок `.login-screen` — форма входа (поле username + кнопка).
> - `<template id="msg-bubble-tpl">` — шаблон бабла сообщения.
> - `<template id="chat-item-tpl">` — шаблон элемента списка чатов.
> - Подвал чата: `.smart-hint-bar` (панель подсказок) + `.input-area` (поле ввода + кнопки).
> - Скрытый `.bottom-sheet` для разбора грамматики.
>
> **Файл `public/styles.css`:**
> - CSS Custom Properties: `--bg-primary`, `--bg-secondary`, `--bubble-mine`, `--bubble-theirs`, `--text-primary`, `--text-secondary`, `--accent`.
> - Telegram-стиль: мягкие тени, скругленные баблы (border-radius: 12px), баблы мои — справа (зеленоватые), чужие — слева (серые).
> - Responsive: sidebar + chat-view рядом на десктопе (≥768px), поочерёдно на мобиле.
> - Анимации: плавное появление сообщений (`@keyframes slideUp`), выезд bottom-sheet (`transform: translateY`).
> - Двухуровневый бабл: верхняя часть = оригинал, разделитель `border-top: 1px`, нижняя часть = эталон (бледнее, курсив, шрифт на 12% меньше).
> - Smart Hint панель: фиксированная полоска высотой 36px, мягкий фон, текст подсказки.
> - Dark-mode готовность: `@media (prefers-color-scheme: dark)` с набором тёмных переменных.
>
> Дизайн должен быть визуально привлекательным, с плавными переходами и ощущением премиального мессенджера. Используй Google Font `Inter`. Цветовая палитра: темно-синие акценты (#2B5278 для header), мягко-зеленые баблы (#DCF8C6), белый/светло-серый фон.

---

### ЭТАП 4: Фронтенд — JS логика (чат без AI)

**Промт для нейросети:**

> Напиши JavaScript логику мессенджера. Vanilla JS, ES Modules. Файлы в папке `public/js/`.
>
> **`public/js/app.js`** — Точка входа:
> - Проверяет `localStorage` на наличие `user`. Если нет — показывает `.login-screen`.
> - При входе: отправляет `POST /api/users`, сохраняет ответ в `localStorage`.
> - Инициализирует модули: `chatList`, `chatView`, `ws`.
>
> **`public/js/api.js`** — HTTP запросы:
> - `login(username)` → `POST /api/users`
> - `getChats(userId)` → `GET /api/chats?user_id=`
> - `createChat(userIds)` → `POST /api/chats`
> - `getMessages(chatId, before?)` → `GET /api/chats/:chatId/messages`
> - Базовый fetch-wrapper с обработкой ошибок.
>
> **`public/js/ws.js`** — WebSocket клиент:
> - Подключение `socket.io-client` к серверу с передачей `user_id` в query.
> - Методы: `joinChat(chatId)`, `sendMessage(chatId, text, localId)`, `sendTyping(chatId)`.
> - Подписка на события: `new_msg`, `msg_ack`, `msg_checked`, `user_typing`.
> - Callback-система: `ws.on('new_msg', callback)` для связи с UI модулями.
>
> **`public/js/chatList.js`** — Список чатов:
> - Загружает чаты через `api.getChats()`, клонирует `<template>`, вставляет в `.sidebar`.
> - По клику на чат → вызывает `chatView.open(chatId)`.
> - Обновляет последнее сообщение при получении `new_msg`.
>
> **`public/js/chatView.js`** — Окно диалога:
> - `open(chatId)`: загружает историю через REST, рендерит баблы, подписывается на WS комнату.
> - `renderMessage(msg)`: клонирует template, расставляет текст, время, свой/чужой стиль.
> - Optimistic UI: при отправке сразу рендерит бабл с «часиками», по `msg_ack` убирает.
> - Автоскролл вниз при новом сообщении. Ленивая подгрузка вверх (infinite scroll).
> - Индикатор набора: «Имя печатает...» в header.
>
> Весь код — чистый, модульный, с JSDoc комментариями на русском.

---

### ЭТАП 5: Сервис проверки текста (LanguageTool)

**Промт для нейросети:**

> Создай серверный сервис проверки английского текста через LanguageTool API с паттерном адаптера для будущей замены на LLM.
>
> **`src/services/textAnalyzer.js`** — Базовый класс (интерфейс):
> ```js
> class TextAnalyzer {
>   async analyze(text) {
>     // Возвращает: { original, corrected, has_errors, errors[], detected_language, provider }
>     throw new Error('Not implemented');
>   }
> }
> ```
>
> **`src/services/languageToolAnalyzer.js`** — Реализация для LanguageTool:
> - Метод `analyze(text)`:
>   1. Отправляет `POST` на `https://api.languagetoolplus.com/v2/check` (или URL из `.env` для self-hosted).
>   2. Payload: `text`, `language: 'en-US'`, `enabledOnly: false`.
>   3. Парсит ответ: если `detectedLanguage.code` начинается с `ru` — возвращает `{ has_errors: false, detected_language: 'ru' }` (пропускаем русский текст).
>   4. Иначе обходит массив `matches` **с конца в начало** (чтобы не сбивать offset).
>   5. Для каждого match формирует объект ошибки: `{ original, corrected, offset, length, rule, category, explanation }`.
>   6. Собирает `corrected` текст путём замены подстрок.
> - Обработка ошибок: если LT API недоступен → возвращает `{ has_errors: false, check_status: 'error' }`.
>
> **`src/services/phraseCache.js`** — Кэш повторяющихся фраз:
> - `Map<string, { result, timestamp }>`.
> - Метод `get(text)` — возвращает результат если не старше 1 часа.
> - Метод `set(text, result)`.
> - Метод `cleanup()` — удаляет устаревшие записи (запускается по setInterval раз в 10 мин).
> - Ключ кэша: `crypto.createHash('md5').update(text.trim().toLowerCase()).digest('hex')`.
>
> **Интеграция в WebSocket pipeline** (`src/ws/socketManager.js`):
> - После `msg_ack` и `new_msg` запускается асинхронная проверка:
>   1. Проверяет кэш → если есть результат, использует его.
>   2. Если нет → вызывает `analyzer.analyze(text)`.
>   3. Кэширует результат.
>   4. Обновляет запись в БД: `UPDATE messages SET check_status, corrected_text, has_errors, correction_data`.
>   5. Рассылает в комнату событие `msg_checked` с `{ msg_id, corrected_text, has_errors, errors[] }`.

---

### ЭТАП 6: Фронтенд — отрисовка проверок и Sub-bubble

**Промт для нейросети:**

> Добавь на фронтенд отрисовку результатов проверки AI. Это «двухуровневый бабл» — под оригинальным текстом сообщения появляется эталонная версия.
>
> **Изменения в `public/js/chatView.js`:**
> - Подписаться на WS event `msg_checked`.
> - По получению `msg_checked`:
>   1. Найти DOM-узел сообщения по `data-msg-id`.
>   2. Если `has_errors === true`:
>      - Создать элемент `.correction-sub-bubble` внутри бабла.
>      - Содержимое: разделительная линия + исправленный текст (курсив, бледнее).
>      - Добавить иконку 💡 (кнопка «Разбор»).
>      - Сохранить `correction_data` в `dataset` элемента.
>      - Анимация: плавное раскрытие вниз (`max-height` transition).
>   3. Если `has_errors === false` и `detected_language !== 'ru'`:
>      - Добавить маленький индикатор `EN ✓` рядом с временем сообщения.
>   4. Если `detected_language === 'ru'`:
>      - Ничего не показывать (русский текст не проверяется).
>
> **Стили (добавить в `public/styles.css`):**
> - `.correction-sub-bubble`: бледно-серый фон (--bg-correction), шрифт 88% от основного, font-style italic, border-top 1px solid мягкий.
> - Подсветка ошибок в оригинале: красное зачёркивание.
> - Иконка 💡: абсолютное позиционирование справа внизу sub-bubble, при hover — увеличение.
> - `.en-check`: маленький зелёный бейдж (`EN ✓`), font-size 10px.

---

### ЭТАП 7: Bottom Sheet — грамматический разбор

**Промт для нейросети:**

> Реализуй Bottom Sheet (шторку) для подробного разбора грамматических ошибок. Шторка выезжает снизу при нажатии на иконку 💡 в исправлении.
>
> **`public/js/bottomSheet.js`:**
> - Функция `openSheet(correctionData)`:
>   1. Заполняет `.bottom-sheet` контентом:
>      - Заголовок: «Разбор грамматики»
>      - Эталонная фраза целиком (жирным).
>      - Список ошибок (из `correction_data.errors`):
>        - Каждая ошибка: блок с `❌ Ошибка: "I wants"` → `✅ Правильно: "I want"`.
>        - Под ним: пояснение от LanguageTool (поле `explanation`/`message`).
>        - Название правила (`rule`) как тег-бейдж (Grammar, Spelling, Style...).
>   2. Добавляет overlay (полупрозрачный фон).
>   3. Анимирует выезд: `transform: translateY(0)` с transition 300ms ease.
> - Функция `closeSheet()`:
>   1. Анимирует скрытие: `transform: translateY(100%)`.
>   2. Убирает overlay. 
> - Поддержка свайпа вниз для закрытия (touch events: `touchstart`, `touchmove`, `touchend`).
> - Клик по overlay = закрытие.
>
> **Изменения в `public/js/chatView.js`:**
> - Делегированный listener на `.message-area`: при клике по `.breakdown-btn` (иконка 💡):
>   - Извлечь `correction_data` из `dataset` родительского бабла.
>   - Вызвать `bottomSheet.openSheet(JSON.parse(data))`.
>
> **Стили (добавить в `public/styles.css`):**
> - `.bottom-sheet`: фиксированная панель снизу, max-height 60vh, border-radius: 16px 16px 0 0, box-shadow сверху.
> - `.bottom-sheet-overlay`: position fixed, inset 0, background rgba(0,0,0,0.4).
> - `.error-card`: карточка ошибки с иконками, границей и отступами.
> - Drag-handle: серая полоска 40×4px по центру сверху.

---

### ЭТАП 8: Smart Hint — панель подсказок при наборе

**Промт для нейросети:**

> Реализуй панель «Smart Hint» — узкую полосу над полем ввода, которая показывает подсказки при наборе текста.
>
> **MVP-версия (без LLM):**
> Поскольку LanguageTool проверяет ПОСЛЕ отправки, Smart Hint в MVP работает как «предпросмотр проверки» — отправляет текст на проверку с debounce при наборе.
>
> **`public/js/smartHint.js`:**
> - Следит за вводом в textarea с debounce 800ms.
> - Когда пользователь делает паузу ≥800ms и текст ≥ 3 слова:
>   1. Отправляет REST запрос `POST /api/check` к серверу (новый endpoint).
>   2. Сервер вызывает `languageToolAnalyzer.analyze(text)` и возвращает результат.
>   3. Если есть исправления — показать в `.smart-hint-bar`: исправленный текст подсвеченный.
>   4. При клике на подсказку — заменить текст в поле ввода на исправленный.
> - Пустой инпут → «AI ассистент готов ✨».
> - Текст < 3 слов → скрыть подсказку.
> - Анимация появления: fade-in + slide-up.
>
> **Новый REST endpoint `POST /api/check`:**
> - Принимает `{ text }`, возвращает `AnalysisResult`.
> - Использует тот же `languageToolAnalyzer` + `phraseCache`.
>
> **Стили:**
> - `.smart-hint-bar`: высота auto (min 36px), padding 6px 12px, фон чуть темнее основного, border-bottom.
> - `.hint-text`: цвет акцента, курсор pointer, при hover — подчёркивание.
> - `.hint-placeholder`: серый текст «AI ассистент готов ✨».

---

### ЭТАП 9: Финализация, Edge Cases и полировка

**Промт для нейросети:**

> Выполни финальную полировку мессенджера. **Деплой: Render Free + Supabase Free.** Проверь и исправь все edge cases:
>
> 1. **Безопасность:**
>    - Экранирование входящего текста от XSS (sanitize перед вставкой в DOM).
>    - Валидация на сервере: длина текста (max 2000 символов), наличие обязательных полей.
>    - Валидация загрузки изображений: проверка MIME-типа (только JPEG/PNG/WebP), размер ≤ 10 МБ.
>
> 2. **Graceful degradation:**
>    - Если LanguageTool API недоступен — сообщение отправляется нормально, просто без плашки.
>    - Показать toast «Проверка временно недоступна» (один раз за сессию).
>    - Retry логика: если LT вернул 5xx — повторить через 3 секунды (max 2 попытки).
>
> 3. **Обработка холодного старта Render Free:**
>    - На фронте: если первый запрос отдаёт таймаут — показать «Сервер просыпается, подождите несколько секунд...» + спиннер.
>    - Авто-retry подключения WebSocket с exponential backoff.
>
> 4. **UX полировка:**
>    - Звук отправки (тихий «свуш»).
>    - Вибрация при получении (если поддерживается, `navigator.vibrate(50)`).
>    - Плавный автоскролл при новых сообщениях (если пользователь внизу чата).
>    - Если пользователь прокрутил вверх — показать кнопку «↓ Новые сообщения».
>    - Placeholder в пустом чате: «Начните общение на английском! 🎓».
>
> 5. **Responsive дизайн:**
>    - Мобильные устройства: sidebar и chat на полный экран, переключение через навигацию.
>    - Адаптивный bottom-sheet (на мобиле на весь экран, на десктопе — max-width 480px по центру).
>
> 6. **Производительность:**
>    - Пагинация сообщений (LIMIT 50 с cursor-пагинацией).
>    - Lazy load аватаров и изображений в сообщениях.
>    - **Проверить работу `cleanupService`**: убедиться, что старые сообщения и изображения удаляются по расписанию.
>
> 7. **Тестовые данные:**
>    - Создай seed-скрипт `src/db/seed.js`: 2 тестовых пользователя, 1 чат между ними, 10 сообщений с примерами ошибок и correction_data.

---

### ЭТАП 10 (Будущее): Подключение локальной LLM

**Промт для нейросети (для будущего этапа):**

> Замени LanguageTool на локальную LLM для проверки и разбора грамматики. Используй паттерн адаптера.
>
> 1. Создай `src/services/localLLMAnalyzer.js extends TextAnalyzer`.
> 2. Промт для LLM: системный промт, который просит модель:
>    - Найти грамматические ошибки.
>    - Вернуть JSON в формате `AnalysisResult`.
>    - Дать развёрнутое объяснение каждой ошибки.
> 3. Endpoint LLM: `http://localhost:{PORT}/v1/chat/completions` (совместимый с OpenAI API).
> 4. В `.env` добавить `AI_PROVIDER=local_llm`, `LLM_BASE_URL`, `LLM_MODEL`.
> 5. Фабрика в `src/services/analyzerFactory.js`: создаёт нужный анализатор по `AI_PROVIDER`.
> 6. Smart Hint в этом режиме: LLM может предлагать перевод с русского на английский.

---

## Сводная таблица этапов

| # | Этап | Результат | Зависит от |
|---|------|-----------|-----------|
| 1 | Инфраструктура + Бэкенд | Сервер, БД (Supabase), REST API, cleanup-cron, загрузка изображений | — |
| 2 | WebSocket реалтайм | Обмен сообщениями в реальном времени | 1 |
| 3 | Фронтенд верстка | Telegram-style HTML/CSS | — |
| 4 | Фронтенд JS логика | Работающий чат без AI | 1, 2, 3 |
| 5 | Сервис LanguageTool | Проверка текста на бэкенде | 1, 2 |
| 6 | Отрисовка проверок | Двухуровневые баблы | 4, 5 |
| 7 | Bottom Sheet | Шторка грамматического разбора | 6 |
| 8 | Smart Hint | Подсказки при наборе | 4, 5 |
| 9 | Полировка | Edge cases, UX, cold-start, cleanup верификация | Все |
| 10 | Локальная LLM | Замена LT на свою модель | 5 |

> **Замечание:** Этапы 1+3 можно выполнять параллельно (бэкенд и вёрстка независимы). Этап 4 объединяет их. Этапы 7 и 8 независимы друг от друга.
