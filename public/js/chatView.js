/**
 * chatView.js — Модуль окна диалога (chat view).
 *
 * Загружает историю сообщений, рендерит баблы из <template>,
 * Optimistic UI при отправке, автоскролл, infinite scroll вверх,
 * индикатор набора текста.
 *
 * @module chatView
 */

import * as api from './api.js';
import * as ws from './ws.js';

// --- DOM элементы ---
let chatView, chatHeader, chatHeaderName, chatHeaderStatus, chatAvatar;
let messageArea, messageAreaEmpty, scrollBottomBtn;
let messageInput, sendBtn;
let sidebar;

/** @type {HTMLTemplateElement} */
let msgBubbleTpl;

/** ID текущего пользователя */
let currentUserId = '';

/** ID текущего открытого чата */
let currentChatId = null;

/** Данные текущего чата */
let currentChatData = null;

/** Курсор пагинации (ISO datetime) */
let nextCursor = null;

/** Есть ли ещё сообщения для подгрузки */
let hasMore = false;

/** Флаг загрузки (защита от дублирования) */
let isLoading = false;

/** Счётчик для локальных ID (Optimistic UI) */
let localIdCounter = 0;

/** Таймер индикатора набора */
let typingTimer = null;

/** Таймер debounce для отправки typing */
let typingDebounce = null;

/** Колбэк для обновления списка чатов */
let onMessageSent = null;

/**
 * Инициализация модуля окна диалога.
 *
 * @param {string} userId — UUID текущего пользователя
 * @param {Object} [callbacks] — колбэки
 * @param {Function} [callbacks.onMessageSent] — (chatId, text, createdAt)
 */
export function init(userId, callbacks = {}) {
  currentUserId = userId;
  onMessageSent = callbacks.onMessageSent || null;

  // DOM элементы
  chatView = document.getElementById('chat-view');
  chatHeader = document.getElementById('chat-header');
  chatHeaderName = document.getElementById('chat-header-name');
  chatHeaderStatus = document.getElementById('chat-header-status');
  chatAvatar = document.getElementById('chat-avatar');
  messageArea = document.getElementById('message-area');
  messageAreaEmpty = document.getElementById('message-area-empty');
  scrollBottomBtn = document.getElementById('scroll-bottom-btn');
  messageInput = document.getElementById('message-input');
  sendBtn = document.getElementById('btn-send');
  sidebar = document.getElementById('sidebar');
  msgBubbleTpl = document.getElementById('msg-bubble-tpl');

  // --- Обработчики UI ---

  // Кнопка отправки
  sendBtn.addEventListener('click', handleSend);

  // Enter для отправки (Shift+Enter — перенос строки)
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // Авторесайз textarea
  messageInput.addEventListener('input', () => {
    // Включаем/выключаем кнопку отправки
    sendBtn.disabled = !messageInput.value.trim();

    // Авторесайз
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';

    // Индикатор набора
    handleTyping();
  });

  // Кнопка «назад» (мобильный)
  document.getElementById('btn-back').addEventListener('click', closeChat);

  // Scroll-to-bottom
  scrollBottomBtn.addEventListener('click', () => {
    messageArea.scrollTo({ top: messageArea.scrollHeight, behavior: 'smooth' });
  });

  // Показ/скрытие кнопки scroll-to-bottom
  messageArea.addEventListener('scroll', () => {
    const isNearBottom = messageArea.scrollHeight - messageArea.scrollTop - messageArea.clientHeight < 150;
    scrollBottomBtn.classList.toggle('visible', !isNearBottom);

    // Infinite scroll — подгрузка вверх
    if (messageArea.scrollTop < 50 && hasMore && !isLoading) {
      loadMoreMessages();
    }
  });

  // --- Подписки на WS события ---
  ws.on('new_msg', handleNewMessage);
  ws.on('msg_ack', handleMsgAck);
  ws.on('msg_checked', handleMsgChecked);
  ws.on('user_typing', handleUserTyping);
  ws.on('msg_error', handleMsgError);
}

/**
 * Открыть чат: загрузить историю, показать UI.
 *
 * @param {string} chatId — UUID чата
 * @param {Object} chatData — данные чата (из списка)
 */
export async function open(chatId, chatData) {
  currentChatId = chatId;
  currentChatData = chatData;
  nextCursor = null;
  hasMore = false;

  // Обновляем header
  const otherMember = getOtherMember(chatData);
  const displayName = chatData.name || (otherMember ? otherMember.display_name || otherMember.username : 'Чат');
  chatHeaderName.textContent = displayName;
  chatHeaderStatus.textContent = 'онлайн';
  chatHeaderStatus.className = 'chat-header-status';
  chatAvatar.textContent = displayName.charAt(0).toUpperCase();

  // Показываем chat-view, скрываем sidebar на мобиле
  chatView.classList.add('active');
  sidebar.classList.add('hidden-mobile');

  // Скрываем placeholder на десктопе
  const placeholder = document.getElementById('chat-view-placeholder');
  if (placeholder) placeholder.style.display = 'none';

  // Очищаем область сообщений
  clearMessages();

  // Подписываемся на комнату WS
  ws.joinChat(chatId);

  // Загружаем историю
  await loadMessages();

  // Фокус на поле ввода
  messageInput.focus();
}

/**
 * Закрыть чат (мобильная навигация).
 */
export function closeChat() {
  currentChatId = null;
  currentChatData = null;

  chatView.classList.remove('active');
  sidebar.classList.remove('hidden-mobile');

  // Показываем placeholder на десктопе
  const placeholder = document.getElementById('chat-view-placeholder');
  if (placeholder) placeholder.style.display = '';
}

/**
 * Загрузить сообщения чата (первоначальная загрузка).
 */
async function loadMessages() {
  if (!currentChatId || isLoading) return;
  isLoading = true;

  try {
    const data = await api.getMessages(currentChatId);
    hasMore = data.has_more;
    nextCursor = data.next_cursor;

    if (data.messages.length === 0) {
      messageAreaEmpty.style.display = '';
      return;
    }

    messageAreaEmpty.style.display = 'none';

    // Рендерим сообщения
    data.messages.forEach((msg) => {
      renderMessage(msg, false);
    });

    // Скроллим вниз
    scrollToBottom();
  } catch (err) {
    console.error('[ChatView] Ошибка загрузки сообщений:', err.message);
  } finally {
    isLoading = false;
  }
}

/**
 * Подгрузить ещё сообщения (infinite scroll вверх).
 */
async function loadMoreMessages() {
  if (!currentChatId || !hasMore || isLoading || !nextCursor) return;
  isLoading = true;

  // Запоминаем scroll position
  const scrollHeightBefore = messageArea.scrollHeight;

  try {
    const data = await api.getMessages(currentChatId, nextCursor);
    hasMore = data.has_more;
    nextCursor = data.next_cursor;

    // Вставляем сообщения в начало
    const firstChild = messageArea.querySelector('.msg-row');
    data.messages.forEach((msg) => {
      const el = createMessageEl(msg);
      messageArea.insertBefore(el, firstChild);
    });

    // Восстанавливаем scroll position
    const scrollHeightAfter = messageArea.scrollHeight;
    messageArea.scrollTop = scrollHeightAfter - scrollHeightBefore;
  } catch (err) {
    console.error('[ChatView] Ошибка подгрузки сообщений:', err.message);
  } finally {
    isLoading = false;
  }
}

/**
 * Отрендерить одно сообщение (добавить в конец).
 *
 * @param {Object} msg — объект сообщения
 * @param {boolean} [animate=true] — плавное появление
 */
function renderMessage(msg, animate = true) {
  const el = createMessageEl(msg, animate);
  messageArea.appendChild(el);
}

/**
 * Создать DOM-элемент бабла сообщения из <template>.
 *
 * @param {Object} msg — объект сообщения
 * @param {boolean} [animate=true]
 * @returns {HTMLElement}
 */
function createMessageEl(msg, animate = true) {
  const fragment = msgBubbleTpl.content.cloneNode(true);
  const row = fragment.querySelector('.msg-row');

  const isMine = msg.sender_id === currentUserId;

  // Класс: мой / чужой
  row.classList.add(isMine ? 'mine' : 'theirs');
  row.dataset.msgId = msg.id || '';
  row.dataset.localId = msg.local_id || '';

  // Без анимации при загрузке истории
  if (!animate) {
    row.style.animation = 'none';
  }

  // Текст сообщения (экранирование XSS)
  const originalEl = row.querySelector('.msg-original');
  originalEl.textContent = msg.original_text;

  // Время
  const timeEl = row.querySelector('.msg-time');
  timeEl.textContent = formatMessageTime(msg.created_at);

  // Статус (для моих сообщений)
  const statusEl = row.querySelector('.msg-status');
  if (isMine) {
    if (msg.id) {
      statusEl.textContent = '✓';
      statusEl.classList.add('sent');
    } else {
      // Optimistic UI: ещё не подтверждено
      statusEl.textContent = '🕐';
    }
  }

  // Если уже есть данные проверки — показываем sub-bubble
  if (msg.has_errors && msg.corrected_text) {
    showCorrectionSubBubble(row, msg);
  } else if (msg.check_status === 'done' && !msg.has_errors && msg.corrected_text !== null) {
    // Нет ошибок, проверка завершена
    const enCheck = row.querySelector('.en-check');
    enCheck.textContent = 'EN ✓';
    enCheck.classList.remove('hidden');
  }

  return row;
}

/**
 * Показать sub-bubble с исправлением.
 *
 * @param {HTMLElement} row — .msg-row элемент
 * @param {Object} msg — объект с corrected_text и correction_data
 */
function showCorrectionSubBubble(row, msg) {
  const subBubble = row.querySelector('.correction-sub-bubble');
  const correctionText = subBubble.querySelector('.correction-text');

  correctionText.textContent = msg.corrected_text;

  // Сохраняем данные коррекции в dataset
  if (msg.correction_data) {
    row.dataset.correctionData = typeof msg.correction_data === 'string'
      ? msg.correction_data
      : JSON.stringify(msg.correction_data);
  }

  // Показываем с анимацией
  requestAnimationFrame(() => {
    subBubble.classList.add('visible');
  });
}

/**
 * Обработчик отправки сообщения.
 */
function handleSend() {
  const text = messageInput.value.trim();
  if (!text || !currentChatId) return;

  const localId = `local_${++localIdCounter}_${Date.now()}`;

  // Optimistic UI: рендерим сообщение сразу
  const optimisticMsg = {
    local_id: localId,
    id: null,
    chat_id: currentChatId,
    sender_id: currentUserId,
    original_text: text,
    check_status: 'pending',
    created_at: new Date().toISOString(),
  };

  messageAreaEmpty.style.display = 'none';
  renderMessage(optimisticMsg, true);
  scrollToBottom();

  // Отправляем через WS
  ws.sendMessage(currentChatId, text, localId);

  // Очищаем поле ввода
  messageInput.value = '';
  messageInput.style.height = 'auto';
  sendBtn.disabled = true;

  // Обновляем список чатов
  if (onMessageSent) {
    onMessageSent(currentChatId, text, optimisticMsg.created_at);
  }
}

/**
 * Обработка подтверждения отправки (msg_ack).
 *
 * @param {Object} data — { local_id, msg_id, status }
 */
function handleMsgAck(data) {
  const row = messageArea.querySelector(`.msg-row[data-local-id="${data.local_id}"]`);
  if (!row) return;

  // Обновляем msg_id
  row.dataset.msgId = data.msg_id;

  // Обновляем статус
  const statusEl = row.querySelector('.msg-status');
  if (statusEl) {
    statusEl.textContent = '✓';
    statusEl.classList.add('sent');
  }
}

/**
 * Обработка нового входящего сообщения.
 *
 * @param {Object} msg — сообщение от WS
 */
function handleNewMessage(msg) {
  // Только для текущего чата
  if (msg.chat_id !== currentChatId) return;

  // Не рендерим свои сообщения (уже есть Optimistic UI)
  if (msg.sender_id === currentUserId) return;

  messageAreaEmpty.style.display = 'none';
  renderMessage(msg, true);

  // Автоскролл если пользователь внизу
  const isNearBottom = messageArea.scrollHeight - messageArea.scrollTop - messageArea.clientHeight < 200;
  if (isNearBottom) {
    scrollToBottom();
  }
}

/**
 * Обработка результата AI-проверки.
 *
 * @param {Object} data — { msg_id, corrected_text, has_errors, errors[] }
 */
function handleMsgChecked(data) {
  const row = messageArea.querySelector(`.msg-row[data-msg-id="${data.msg_id}"]`);
  if (!row) return;

  if (data.has_errors && data.corrected_text) {
    showCorrectionSubBubble(row, {
      corrected_text: data.corrected_text,
      correction_data: { errors: data.errors || [] },
    });
  } else if (!data.has_errors) {
    // Нет ошибок — показать EN ✓
    const enCheck = row.querySelector('.en-check');
    if (enCheck) {
      enCheck.textContent = 'EN ✓';
      enCheck.classList.remove('hidden');
    }
  }
}

/**
 * Обработка индикатора набора текста.
 *
 * @param {Object} data — { user_id, chat_id }
 */
function handleUserTyping(data) {
  if (data.chat_id !== currentChatId) return;

  // Находим имя печатающего
  const typingUser = currentChatData?.members?.find((m) => m.user_id === data.user_id);
  const name = typingUser ? (typingUser.display_name || typingUser.username) : 'Кто-то';

  chatHeaderStatus.textContent = `${name} печатает...`;
  chatHeaderStatus.className = 'chat-header-status typing';

  // Убираем через 3 секунды
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    chatHeaderStatus.textContent = 'онлайн';
    chatHeaderStatus.className = 'chat-header-status online';
  }, 3000);
}

/**
 * Обработка ошибки отправки сообщения.
 *
 * @param {Object} data — { local_id, error }
 */
function handleMsgError(data) {
  const row = messageArea.querySelector(`.msg-row[data-local-id="${data.local_id}"]`);
  if (!row) return;

  const statusEl = row.querySelector('.msg-status');
  if (statusEl) {
    statusEl.textContent = '⚠️';
    statusEl.title = data.error || 'Ошибка отправки';
  }
}

/**
 * Отправка индикатора набора текста с debounce.
 */
function handleTyping() {
  if (!currentChatId) return;

  clearTimeout(typingDebounce);
  typingDebounce = setTimeout(() => {
    ws.sendTyping(currentChatId);
  }, 300);
}

/**
 * Очистить область сообщений.
 */
function clearMessages() {
  const rows = messageArea.querySelectorAll('.msg-row');
  rows.forEach((row) => row.remove());
  messageAreaEmpty.style.display = '';
}

/**
 * Плавный скролл в самый низ.
 */
function scrollToBottom() {
  requestAnimationFrame(() => {
    messageArea.scrollTop = messageArea.scrollHeight;
  });
}

/**
 * Форматировать время сообщения (HH:MM).
 *
 * @param {string} isoDate — ISO datetime
 * @returns {string}
 */
function formatMessageTime(isoDate) {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Получить участника чата, который НЕ текущий пользователь.
 *
 * @param {Object} chat
 * @returns {Object|null}
 */
function getOtherMember(chat) {
  if (!chat.members || chat.members.length === 0) return null;
  return chat.members.find((m) => m.user_id !== currentUserId) || chat.members[0];
}

/**
 * Получить текущий открытый chatId.
 *
 * @returns {string|null}
 */
export function getCurrentChatId() {
  return currentChatId;
}
