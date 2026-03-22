/**
 * Text-Me: Точка входа серверного приложения.
 *
 * Fastify-сервер с поддержкой:
 * - CORS (для разработки и продакшена)
 * - Раздача статики из public/
 * - Multipart (загрузка файлов до 10 МБ)
 * - REST API роуты
 * - Cron-задачи очистки данных
 *
 * Деплой: Render.com Free Tier
 */

// Загрузка переменных окружения (должен быть первым!)
require('dotenv').config();

const path = require('path');
const fastify = require('fastify')({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  },
  // Ограничение размера тела запроса (для JSON)
  bodyLimit: 1048576, // 1 МБ для JSON-запросов
});

// =============================================
// ПЛАГИНЫ
// =============================================

// CORS — разрешаем запросы с фронтенда
fastify.register(require('@fastify/cors'), {
  origin: true, // В продакшене заменить на конкретный домен
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
});

// Раздача статических файлов из public/
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/',
  // Не логировать каждый запрос статики
  decorateReply: true,
});

// Multipart для загрузки файлов (изображения до 10 МБ)
fastify.register(require('@fastify/multipart'), {
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 МБ
    files: 1, // Один файл за раз
  },
});

// =============================================
// РОУТЫ API
// =============================================

fastify.register(require('./routes/auth'));
fastify.register(require('./routes/chats'));
fastify.register(require('./routes/messages'));
fastify.register(require('./routes/images'));

// =============================================
// HEALTH CHECK (для Render.com)
// =============================================

fastify.get('/api/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// =============================================
// ЗАПУСК СЕРВЕРА
// =============================================

const start = async () => {
  try {
    const port = parseInt(process.env.PORT, 10) || 3000;
    const host = '0.0.0.0'; // Render.com требует привязку к 0.0.0.0

    await fastify.listen({ port, host });

    console.log('='.repeat(50));
    console.log(`🚀 Text-Me сервер запущен: http://localhost:${port}`);
    console.log(`📁 Статика: ${path.join(__dirname, '..', 'public')}`);
    console.log('='.repeat(50));

    // Инициализация cron-задач очистки данных
    const { startCleanupCron } = require('./services/cleanupService');
    startCleanupCron();
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
