/**
 * phraseCache.js — Кэш повторяющихся фраз для мгновенного ответа.
 *
 * Хранит результаты анализа в Map с TTL 1 час.
 * Ключ — MD5 хеш нормализованного текста.
 * Очистка устаревших записей — каждые 10 минут.
 */

const crypto = require('crypto');

/** TTL кэша — 1 час (мс) */
const CACHE_TTL = 60 * 60 * 1000;

/** Интервал очистки — 10 минут (мс) */
const CLEANUP_INTERVAL = 10 * 60 * 1000;

/** Хранилище: hash → { result, timestamp } */
const cache = new Map();

/** ID интервала очистки */
let cleanupIntervalId = null;

/**
 * Сгенерировать ключ кэша из текста.
 *
 * @param {string} text — исходный текст
 * @returns {string} — MD5 хеш
 */
function makeKey(text) {
  return crypto
    .createHash('md5')
    .update(text.trim().toLowerCase())
    .digest('hex');
}

/**
 * Получить результат из кэша.
 *
 * @param {string} text — текст для поиска
 * @returns {Object|null} — результат анализа или null
 */
function get(text) {
  const key = makeKey(text);
  const entry = cache.get(key);

  if (!entry) return null;

  // Проверяем TTL
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }

  return entry.result;
}

/**
 * Сохранить результат в кэш.
 *
 * @param {string} text — исходный текст
 * @param {Object} result — результат анализа
 */
function set(text, result) {
  const key = makeKey(text);
  cache.set(key, {
    result,
    timestamp: Date.now(),
  });
}

/**
 * Удалить устаревшие записи из кэша.
 */
function cleanup() {
  const now = Date.now();
  let deleted = 0;

  for (const [key, entry] of cache) {
    if (now - entry.timestamp > CACHE_TTL) {
      cache.delete(key);
      deleted++;
    }
  }

  if (deleted > 0) {
    console.log(`[Cache] Очищено ${deleted} устаревших записей. Осталось: ${cache.size}`);
  }
}

/**
 * Запустить автоочистку по интервалу (каждые 10 мин).
 */
function startCleanup() {
  if (cleanupIntervalId) return;
  cleanupIntervalId = setInterval(cleanup, CLEANUP_INTERVAL);
  console.log('[Cache] Автоочистка запущена (каждые 10 мин)');
}

/**
 * Остановить автоочистку.
 */
function stopCleanup() {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
}

/**
 * Получить текущий размер кэша.
 * @returns {number}
 */
function size() {
  return cache.size;
}

// Запускаем автоочистку при загрузке модуля
startCleanup();

module.exports = { get, set, cleanup, startCleanup, stopCleanup, size };
