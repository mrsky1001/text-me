/**
 * Сервис автоматической очистки данных (серверный fallback cron).
 *
 * pg_cron на Supabase — основной механизм очистки записей в БД.
 * Этот сервис — резервный вариант, а также единственный способ
 * удалять ФАЙЛЫ из Supabase Storage (pg_cron не имеет доступа к Storage API).
 *
 * Расписание:
 * - Каждый час: удаление старых сообщений через SQL-функцию
 * - Каждый час: удаление просроченных изображений из Storage + БД
 */

const cron = require('node-cron');
const db = require('../db/index');
const { deleteFiles } = require('./supabaseClient');

/**
 * Удаление старых сообщений через SQL-функцию cleanup_old_messages().
 * Каскадно удаляет связанные записи message_images (ON DELETE CASCADE).
 */
async function cleanupOldMessages() {
  const retentionDays = parseInt(process.env.RETENTION_DAYS_MESSAGES, 10) || 3;

  try {
    const result = await db.query(
      'SELECT cleanup_old_messages($1) AS deleted_count',
      [retentionDays]
    );
    const deleted = result.rows[0]?.deleted_count || 0;

    if (deleted > 0) {
      console.log(`[Cleanup] Удалено ${deleted} старых сообщений (старше ${retentionDays} дней).`);
    }
  } catch (err) {
    console.error('[Cleanup] Ошибка удаления сообщений:', err.message);
  }
}

/**
 * Удаление просроченных изображений:
 * 1. Запрашивает из БД записи с expires_at < NOW()
 * 2. Удаляет файлы из Supabase Storage по storage_path
 * 3. Удаляет записи из БД
 */
async function cleanupExpiredImages() {
  try {
    // Шаг 1: Получаем просроченные изображения из БД
    const result = await db.query(
      `SELECT id, storage_path
       FROM message_images
       WHERE expires_at < NOW()
       LIMIT 100` // Обрабатываем порциями, чтобы не перегружать
    );

    if (result.rows.length === 0) {
      return; // Нечего удалять
    }

    const storagePaths = result.rows.map((row) => row.storage_path);
    const imageIds = result.rows.map((row) => row.id);

    console.log(`[Cleanup] Найдено ${storagePaths.length} просроченных изображений.`);

    // Шаг 2: Удаляем файлы из Supabase Storage
    const { deleted, error } = await deleteFiles(storagePaths);
    if (error) {
      console.error('[Cleanup] Ошибка удаления файлов из Storage:', error.message);
      // Продолжаем удаление записей из БД даже при ошибке Storage
    } else {
      console.log(`[Cleanup] Удалено ${deleted} файлов из Supabase Storage.`);
    }

    // Шаг 3: Удаляем записи из БД
    await db.query(
      `DELETE FROM message_images WHERE id = ANY($1::uuid[])`,
      [imageIds]
    );

    console.log(`[Cleanup] Удалено ${imageIds.length} записей изображений из БД.`);
  } catch (err) {
    console.error('[Cleanup] Ошибка очистки изображений:', err.message);
  }
}

/**
 * Инициализация cron-задач.
 * Вызывается при старте сервера.
 */
function startCleanupCron() {
  // Каждый час (в 0 минут): очистка старых сообщений
  cron.schedule('0 * * * *', async () => {
    console.log('[Cleanup] Запуск очистки старых сообщений...');
    await cleanupOldMessages();
  });

  // Каждый час (в 30 минут): очистка просроченных изображений из Storage + БД
  cron.schedule('30 * * * *', async () => {
    console.log('[Cleanup] Запуск очистки просроченных изображений...');
    await cleanupExpiredImages();
  });

  console.log('[Cleanup] Cron-задачи инициализированы:');
  console.log('  - Очистка сообщений: каждый час (xx:00)');
  console.log('  - Очистка изображений: каждый час (xx:30)');
}

module.exports = { startCleanupCron, cleanupOldMessages, cleanupExpiredImages };
