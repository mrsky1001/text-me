/**
 * Модуль подключения к PostgreSQL через Supabase Connection Pooler (PgBouncer).
 * Настройки берутся из .env (DATABASE_URL).
 * max: 5 — экономия соединений на free-tier Supabase.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Экономия соединений: free-tier Supabase допускает ~60 соединений,
  // PgBouncer на стороне Supabase помогает, но мы тоже ограничиваем пул
  max: 5,
  // Таймаут ожидания свободного соединения из пула (мс)
  idleTimeoutMillis: 30000,
  // Таймаут подключения к БД (мс)
  connectionTimeoutMillis: 10000,
  // Для Supabase Connection Pooler (PgBouncer) необходимо
  ssl: {
    rejectUnauthorized: false,
  },
});

// Логирование ошибок пула
pool.on('error', (err) => {
  console.error('[DB] Непредвиденная ошибка пула:', err.message);
});

/**
 * Выполнение SQL-запроса с параметрами (prepared statement).
 * @param {string} text — SQL-запрос с $1, $2... плейсхолдерами
 * @param {Array} params — массив параметров
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params = []) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    // Логируем медленные запросы (>500мс)
    if (duration > 500) {
      console.warn(`[DB] Медленный запрос (${duration}мс):`, text.substring(0, 80));
    }
    return result;
  } catch (err) {
    console.error('[DB] Ошибка запроса:', err.message);
    console.error('[DB] SQL:', text.substring(0, 200));
    throw err;
  }
}

/**
 * Получение клиента из пула для транзакций.
 * ВАЖНО: не забывать вызывать client.release() после использования.
 * @returns {Promise<import('pg').PoolClient>}
 */
async function getClient() {
  return pool.connect();
}

module.exports = { pool, query, getClient };
