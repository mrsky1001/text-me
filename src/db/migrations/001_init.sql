-- ============================================================
-- МИГРАЦИЯ 001: Инициализация схемы БД для Text-Me мессенджера
-- Деплой: Supabase Free Tier (PostgreSQL 15+)
-- ============================================================

-- Включаем расширение для генерации UUID (если ещё не включено)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ========================================
-- ПОЛЬЗОВАТЕЛИ
-- ========================================
CREATE TABLE IF NOT EXISTS users (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username     VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100),
    native_lang  VARCHAR(5) DEFAULT 'ru',
    target_lang  VARCHAR(5) DEFAULT 'en',
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ========================================
-- ЧАТЫ
-- ========================================
CREATE TABLE IF NOT EXISTS chats (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(100),
    is_group   BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Связь пользователей с чатами (многие ко многим)
CREATE TABLE IF NOT EXISTS chat_members (
    chat_id   UUID REFERENCES chats(id) ON DELETE CASCADE,
    user_id   UUID REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (chat_id, user_id)
);

-- ========================================
-- СООБЩЕНИЯ (двухуровневая модель)
-- ========================================
CREATE TABLE IF NOT EXISTS messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id         UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id       UUID NOT NULL REFERENCES users(id),
    original_text   TEXT NOT NULL,
    -- Статус проверки AI: 'pending' | 'checking' | 'done' | 'skipped' | 'error'
    check_status    VARCHAR(20) DEFAULT 'pending',
    corrected_text  TEXT,
    has_errors      BOOLEAN DEFAULT FALSE,
    -- JSONB с детальной информацией об ошибках (см. architecture.md)
    correction_data JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Индекс для быстрой выборки сообщений чата с сортировкой по дате
CREATE INDEX IF NOT EXISTS idx_messages_chat_created
    ON messages(chat_id, created_at DESC);

-- Индекс для поиска сообщений по отправителю
CREATE INDEX IF NOT EXISTS idx_messages_sender
    ON messages(sender_id);

-- Частичный индекс для быстрой очистки старых сообщений
-- Покрывает только записи старше 3 дней — минимальный размер индекса
CREATE INDEX IF NOT EXISTS idx_messages_cleanup
    ON messages(created_at)
    WHERE created_at < NOW() - INTERVAL '3 days';

-- ========================================
-- ИЗОБРАЖЕНИЯ В СООБЩЕНИЯХ (макс 10 МБ)
-- ========================================
CREATE TABLE IF NOT EXISTS message_images (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id   UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    storage_path TEXT NOT NULL,            -- путь в Supabase Storage (bucket: chat-images)
    file_size    INTEGER NOT NULL,         -- размер в байтах (макс 10485760 = 10 МБ)
    mime_type    VARCHAR(20) NOT NULL,     -- image/jpeg, image/png, image/webp
    width        INTEGER,                  -- ширина изображения (пикс.)
    height       INTEGER,                  -- высота изображения (пикс.)
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    -- TTL: автоудаление через N дней (по умолчанию 3)
    expires_at   TIMESTAMPTZ DEFAULT NOW() + INTERVAL '3 days'
);

-- Индекс для cron-очистки просроченных изображений
CREATE INDEX IF NOT EXISTS idx_images_expires
    ON message_images(expires_at);

-- Индекс для поиска изображений конкретного сообщения
CREATE INDEX IF NOT EXISTS idx_images_message
    ON message_images(message_id);

-- ========================================
-- ФУНКЦИИ АВТОМАТИЧЕСКОЙ ОЧИСТКИ ДАННЫХ
-- ========================================

-- Функция удаления старых сообщений (вызывается по cron)
-- Каскадное удаление: записи message_images удалятся автоматически через ON DELETE CASCADE
CREATE OR REPLACE FUNCTION cleanup_old_messages(retention_days INTEGER DEFAULT 3)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM messages
    WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RAISE NOTICE 'cleanup_old_messages: удалено % сообщений', deleted_count;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Функция удаления просроченных изображений (записи в БД)
-- ВАЖНО: файлы из Supabase Storage удаляются отдельно через серверный cron
CREATE OR REPLACE FUNCTION cleanup_expired_images()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM message_images
    WHERE expires_at < NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RAISE NOTICE 'cleanup_expired_images: удалено % записей изображений', deleted_count;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ========================================
-- CRON-ЗАДАЧИ (Supabase pg_cron расширение)
-- ========================================
-- ПРИМЕЧАНИЕ: pg_cron должен быть включён в настройках Supabase проекта
-- Dashboard → Database → Extensions → включить pg_cron

-- Очистка сообщений старше 3 дней — каждый час
SELECT cron.schedule(
    'cleanup-messages',
    '0 * * * *',
    'SELECT cleanup_old_messages(3)'
);

-- Очистка просроченных изображений (записей в БД) — каждые 30 минут
SELECT cron.schedule(
    'cleanup-images',
    '*/30 * * * *',
    'SELECT cleanup_expired_images()'
);
