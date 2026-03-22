/**
 * api.js — HTTP fetch-wrapper для REST API мессенджера.
 *
 * Все запросы возвращают JSON. При ошибке сети или сервера
 * бросает исключение с понятным сообщением.
 *
 * @module api
 */

/** Базовый URL API (относительный — тот же origin) */
const BASE = '/api';

/**
 * Базовый fetch-wrapper с обработкой ошибок и таймаутом.
 *
 * @param {string} url — путь относительно BASE
 * @param {RequestInit} [options] — опции fetch
 * @returns {Promise<any>} — распарсенный JSON ответ
 * @throws {Error} — при ошибке сети или не-OK статусе
 */
async function request(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15 сек таймаут

  try {
    const response = await fetch(`${BASE}${url}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Ошибка сервера: ${response.status}`);
    }

    return await response.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Сервер не отвечает. Возможно, он просыпается — попробуйте через 30 секунд.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Вход/регистрация по username (upsert).
 *
 * @param {string} username
 * @returns {Promise<{id: string, username: string, display_name: string, native_lang: string, target_lang: string, created_at: string}>}
 */
export async function login(username) {
  return request('/users', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
}

/**
 * Получить список чатов пользователя с последним сообщением.
 *
 * @param {string} userId — UUID пользователя
 * @returns {Promise<Array<{id: string, name: string, is_group: boolean, members: Array, last_message: Object|null}>>}
 */
export async function getChats(userId) {
  return request(`/chats?user_id=${encodeURIComponent(userId)}`);
}

/**
 * Создать чат между пользователями.
 *
 * @param {string[]} userIds — массив UUID
 * @returns {Promise<{id: string, name: string, is_group: boolean, created_at: string}>}
 */
export async function createChat(userIds) {
  return request('/chats', {
    method: 'POST',
    body: JSON.stringify({ user_ids: userIds }),
  });
}

/**
 * Получить историю сообщений чата с cursor-пагинацией.
 *
 * @param {string} chatId — UUID чата
 * @param {string} [before] — ISO datetime курсор для пагинации
 * @returns {Promise<{messages: Array, has_more: boolean, next_cursor: string|null}>}
 */
export async function getMessages(chatId, before) {
  let url = `/chats/${chatId}/messages`;
  if (before) {
    url += `?before=${encodeURIComponent(before)}`;
  }
  return request(url);
}

/**
 * Найти пользователя по username (используется при создании чата).
 *
 * @param {string} username
 * @returns {Promise<{id: string, username: string, display_name: string}>}
 */
export async function findUser(username) {
  return request('/users', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
}
