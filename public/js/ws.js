/**
 * ws.js — WebSocket клиент через Socket.IO.
 *
 * Подключается к серверу с передачей user_id в query.
 * Предоставляет callback-систему для связи с UI модулями.
 *
 * @module ws
 */

/** @type {import('socket.io-client').Socket|null} */
let socket = null;

/** Хранилище колбэков по событиям */
const listeners = {};

/**
 * Подписка на событие WebSocket.
 *
 * @param {string} event — имя события
 * @param {Function} callback — обработчик
 */
export function on(event, callback) {
  if (!listeners[event]) {
    listeners[event] = [];
  }
  listeners[event].push(callback);
}

/**
 * Вызов всех подписчиков на событие.
 *
 * @param {string} event — имя события
 * @param {*} data — данные события
 */
function emit(event, data) {
  if (listeners[event]) {
    listeners[event].forEach((cb) => cb(data));
  }
}

/**
 * Подключение к WebSocket серверу.
 *
 * @param {string} userId — UUID текущего пользователя
 */
export function connect(userId) {
  if (socket) {
    socket.disconnect();
  }

  // Socket.IO подключён через CDN (глобальный io)
  socket = io({
    query: { user_id: userId },
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    timeout: 15000,
  });

  // --- Обработчики системных событий ---

  socket.on('connect', () => {
    console.log('[WS] Подключён:', socket.id);
    emit('connected', { socketId: socket.id });
  });

  socket.on('disconnect', (reason) => {
    console.log('[WS] Отключён:', reason);
    emit('disconnected', { reason });
  });

  socket.on('connect_error', (err) => {
    console.error('[WS] Ошибка подключения:', err.message);
    emit('connect_error', { error: err.message });
  });

  // --- Обработчики бизнес-событий ---

  /** Подтверждение отправки сообщения */
  socket.on('msg_ack', (data) => {
    // data: { local_id, msg_id, status }
    emit('msg_ack', data);
  });

  /** Новое сообщение от другого пользователя */
  socket.on('new_msg', (data) => {
    // data: { id, chat_id, sender_id, original_text, check_status, created_at }
    emit('new_msg', data);
  });

  /** Результат AI-проверки сообщения */
  socket.on('msg_checked', (data) => {
    // data: { msg_id, corrected_text, has_errors, errors[] }
    emit('msg_checked', data);
  });

  /** Индикатор набора текста */
  socket.on('user_typing', (data) => {
    // data: { user_id, chat_id }
    emit('user_typing', data);
  });

  /** Пользователь стал offline */
  socket.on('user_offline', (data) => {
    // data: { user_id }
    emit('user_offline', data);
  });

  /** Ошибка отправки сообщения */
  socket.on('msg_error', (data) => {
    // data: { local_id, error }
    emit('msg_error', data);
  });
}

/**
 * Подписаться на комнату чата.
 *
 * @param {string} chatId — UUID чата
 */
export function joinChat(chatId) {
  if (socket) {
    socket.emit('join_chat', { chat_id: chatId });
  }
}

/**
 * Отправить сообщение через WebSocket.
 *
 * @param {string} chatId — UUID чата
 * @param {string} text — текст сообщения
 * @param {string} localId — локальный ID для Optimistic UI
 */
export function sendMessage(chatId, text, localId) {
  if (socket) {
    socket.emit('send_message', { chat_id: chatId, text, local_id: localId });
  }
}

/**
 * Отправить индикатор набора текста.
 *
 * @param {string} chatId — UUID чата
 */
export function sendTyping(chatId) {
  if (socket) {
    socket.emit('typing', { chat_id: chatId });
  }
}

/**
 * Отключиться от WebSocket.
 */
export function disconnect() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

/**
 * Проверка: подключён ли сокет.
 *
 * @returns {boolean}
 */
export function isConnected() {
  return socket ? socket.connected : false;
}
