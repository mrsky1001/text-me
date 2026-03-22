/**
 * Скрипт запуска SQL-миграций.
 * Выполняет все .sql файлы из папки src/db/migrations/ по порядку.
 * Использование: npm run db:migrate
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./index');

async function migrate() {
  const migrationsDir = path.join(__dirname, 'migrations');

  // Получаем список SQL-файлов, отсортированных по имени
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('[Migrate] Нет SQL-файлов для выполнения.');
    process.exit(0);
  }

  const client = await pool.connect();

  try {
    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      console.log(`[Migrate] Выполняю: ${file}...`);

      // Пропускаем cron.schedule вызовы — они могут не работать локально
      // pg_cron доступен только на Supabase, поэтому обрабатываем ошибки мягко
      const statements = sql.split(/;\s*$/m).filter((s) => s.trim());

      for (const statement of statements) {
        const trimmed = statement.trim();
        if (!trimmed) continue;

        try {
          await client.query(trimmed);
        } catch (err) {
          // Мягкая обработка ошибок pg_cron (может быть не установлен локально)
          if (err.message.includes('cron') || err.message.includes('schema "cron"')) {
            console.warn(`[Migrate] ⚠ Пропущен cron-вызов (pg_cron не установлен): ${trimmed.substring(0, 60)}...`);
          } else {
            throw err;
          }
        }
      }

      console.log(`[Migrate] ✓ ${file} выполнен успешно.`);
    }

    console.log('[Migrate] Все миграции выполнены.');
  } catch (err) {
    console.error('[Migrate] ✗ Ошибка миграции:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
