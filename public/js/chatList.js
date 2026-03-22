/**
 * chatList.js — Модуль списка чатов (sidebar).
 *
 * Загружает чаты через REST API, рендерит из <template>,
 * обрабатывает клики, обновляет при новых сообщениях.
 *
 * @module chatList
 */

import * as api from './api.js';
import * as ws from './ws.js';

/** @type {HTMLElement} */
let chatListEl;
/** @type {HTMLElement} */
let chatListEmptyEl;
/** @type {HTMLTemplateElement} */
let chatItemTpl;

/** ID текущего пользователя */
let currentUserId = '';

/** Кэш загруженных чатов */
let chats = [];

/** Колбэк при выборе чата */
let onChatSelect = null;

/**
 * Инициализация модуля списка чатов.
 *
 * @param {string} userId — UUID текущего пользователя
 * @param {Function} onSelect — колбэк при выборе чата (chatId, chatData)
 */
export function init(userId, onSelect) {
  currentUserId = userId;
  onChatSelect = onSelect;

  chatListEl = document.getElementById('chat-list');
  chatListEmptyEl = document.getElementById('chat-list-empty');
  chatItemTpl = document.getElementById('chat-item-tpl');

  // Подписка на новые сообщения для обновления списка
  ws.on('new_msg', handleNewMessage);
  ws.on('msg_ack', handleMsgAck);

  // Загрузка списка чатов
  loadChats();
}

/**
 * Загрузить список чатов с сервера и отрендерить.
 */
export async function loadChats() {
  try {
    chats = await api.getChats(currentUserId);
    renderChatList();
  } catch (err) {
    console.error('[ChatList] Ошибка загрузки чатов:', err.message);
  }
}

/**
 * Отрендерить список чатов из кэша.
 */
function renderChatList() {
  // Удаляем старые элементы (кроме empty-placeholder)
  const existingItems = chatListEl.querySelectorAll('.chat-item');
  existingItems.forEach((el) => el.remove());

  if (chats.length === 0) {
    chatListEmptyEl.style.display = '';
    return;
  }

  chatListEmptyEl.style.display = 'none';

  chats.forEach((chat) => {
    const el = createChatItem(chat);
    chatListEl.appendChild(el);
  });
}

/**
 * Создать DOM-элемент чата из <template>.
 *
 * @param {Object} chat — объект чата из API
 * @returns {HTMLElement}
 */
function createChatItem(chat) {
  const fragment = chatItemTpl.content.cloneNode(true);
  const el = fragment.querySelector('.chat-item');

  el.dataset.chatId = chat.id;

  // Определяем имя собеседника (для личных чатов)
  const otherMember = getOtherMember(chat);
  const displayName = chat.name || (otherMember ? otherMember.display_name || otherMember.username : 'Чат');

  // Аватар — первая буква имени
  const avatarLetter = el.querySelector('.avatar-letter');
  avatarLetter.textContent = displayName.charAt(0).toUpperCase();

  // Имя чата
  el.querySelector('.chat-item-name').textContent = displayName;

  // Последнее сообщение
  const lastMsgEl = el.querySelector('.chat-item-last-msg');
  if (chat.last_message) {
    lastMsgEl.textContent = truncateText(chat.last_message.text, 40);
  } else {
    lastMsgEl.textContent = 'Нет сообщений';
  }

  // Время последнего сообщения
  const timeEl = el.querySelector('.chat-item-time');
  if (chat.last_message) {
    timeEl.textContent = formatTime(chat.last_message.created_at);
  }

  // Обработчик клика
  el.addEventListener('click', () => {
    // Убираем active у всех
    chatListEl.querySelectorAll('.chat-item').forEach((item) => item.classList.remove('active'));
    el.classList.add('active');

    if (onChatSelect) {
      onChatSelect(chat.id, chat);
    }
  });

  return el;
}

/**
 * Обработка нового входящего сообщения — обновляем список чатов.
 *
 * @param {Object} msg — сообщение из WS
 */
function handleNewMessage(msg) {
  updateLastMessage(msg.chat_id, msg.original_text, msg.created_at);
}

/**
 * Обработка подтверждения отправки — обновляем последнее сообщение.
 *
 * @param {Object} data — { local_id, msg_id, status }
 */
function handleMsgAck(data) {
  // Находим pendingMessage в chatView для обновления
  // Пока просто перезагрузим список для простоты
}

/**
 * Обновить последнее сообщение в чате (в UI и кэше).
 *
 * @param {string} chatId — UUID чата
 * @param {string} text — текст сообщения
 * @param {string} createdAt — ISO дата
 */
export function updateLastMessage(chatId, text, createdAt) {
  // Обновляем в кэше
  const chatIndex = chats.findIndex((c) => c.id === chatId);
  if (chatIndex !== -1) {
    chats[chatIndex].last_message = {
      text,
      created_at: createdAt,
    };

    // Перемещаем чат на первое место
    const [chat] = chats.splice(chatIndex, 1);
    chats.unshift(chat);
  }

  // Обновляем DOM
  const chatEl = chatListEl.querySelector(`.chat-item[data-chat-id="${chatId}"]`);
  if (chatEl) {
    chatEl.querySelector('.chat-item-last-msg').textContent = truncateText(text, 40);
    chatEl.querySelector('.chat-item-time').textContent = formatTime(createdAt);

    // Перемещаем элемент наверх
    if (chatEl.previousElementSibling) {
      chatListEl.insertBefore(chatEl, chatListEl.querySelector('.chat-item'));
    }
  }
}

/**
 * Добавить новый чат в список (после создания).
 *
 * @param {Object} chat — объект чата
 */
export function addChat(chat) {
  chats.unshift(chat);
  chatListEmptyEl.style.display = 'none';
  const el = createChatItem(chat);
  chatListEl.insertBefore(el, chatListEl.querySelector('.chat-item'));
}

/**
 * Получить участника чата, который НЕ текущий пользователь.
 *
 * @param {Object} chat — объект чата с members[]
 * @returns {Object|null}
 */
function getOtherMember(chat) {
  if (!chat.members || chat.members.length === 0) return null;
  return chat.members.find((m) => m.user_id !== currentUserId) || chat.members[0];
}

/**
 * Обрезать текст до maxLen символов.
 *
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function truncateText(text, maxLen) {
  if (!text) return '';
  return text.length > maxLen ? text.substring(0, maxLen) + '…' : text;
}

/**
 * Форматировать дату/время для отображения в списке чатов.
 *
 * @param {string} isoDate — ISO datetime строка
 * @returns {string} — форматированное время или дата
 */
function formatTime(isoDate) {
  if (!isoDate) return '';

  const date = new Date(isoDate);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (msgDate.getTime() === today.getTime()) {
    // Сегодня — показываем время
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (msgDate.getTime() === yesterday.getTime()) {
    return 'Вчера';
  }

  // Старше — показываем дату
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}
