/**
 * app.js — Точка входа фронтенда мессенджера Text-Me.
 *
 * Управляет авторизацией, инициализацией модулей,
 * модальными окнами и общей навигацией.
 *
 * @module app
 */

import * as api from './api.js';
import * as ws from './ws.js';
import * as chatList from './chatList.js';
import * as chatView from './chatView.js';

// --- DOM элементы ---
const loginScreen = document.getElementById('login-screen');
const loginForm = document.getElementById('login-form');
const loginUsername = document.getElementById('login-username');
const loginBtn = document.getElementById('login-btn');
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const loadingOverlay = document.getElementById('loading-overlay');

// Модальное окно нового чата
const newChatModal = document.getElementById('new-chat-modal');
const newChatUsername = document.getElementById('new-chat-username');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');

// Кнопки
const fabNewChat = document.getElementById('fab-new-chat');
const btnLogout = document.getElementById('btn-logout');

/** Текущий пользователь из localStorage */
let currentUser = null;

// =============================================
// ИНИЦИАЛИЗАЦИЯ
// =============================================

/**
 * Проверить localStorage и инициализировать приложение.
 */
function bootstrap() {
  const saved = localStorage.getItem('textme_user');

  if (saved) {
    try {
      currentUser = JSON.parse(saved);
      showApp();
    } catch (e) {
      localStorage.removeItem('textme_user');
      showLogin();
    }
  } else {
    showLogin();
  }
}

/**
 * Показать экран входа.
 */
function showLogin() {
  loginScreen.classList.remove('hidden');
  app.classList.remove('active');
  loginUsername.focus();
}

/**
 * Показать основное приложение, инициализировать модули.
 */
function showApp() {
  loginScreen.classList.add('hidden');
  app.classList.add('active');

  // Инициализация WebSocket
  ws.connect(currentUser.id);

  // Инициализация списка чатов
  chatList.init(currentUser.id, handleChatSelect);

  // Инициализация окна диалога
  chatView.init(currentUser.id, {
    onMessageSent: (chatId, text, createdAt) => {
      chatList.updateLastMessage(chatId, text, createdAt);
    },
  });

  // Подписка на WS-события для обновления чатов
  ws.on('connected', () => {
    console.log('[App] WebSocket подключён');
  });

  ws.on('disconnected', ({ reason }) => {
    console.log('[App] WebSocket отключён:', reason);
  });

  ws.on('connect_error', () => {
    showToast('Соединение потеряно. Переподключение...');
  });
}

// =============================================
// ОБРАБОТЧИКИ СОБЫТИЙ
// =============================================

/**
 * Обработчик формы входа.
 */
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const username = loginUsername.value.trim();
  if (!username || username.length < 2) return;

  loginBtn.disabled = true;
  loginBtn.textContent = 'Вхожу...';

  try {
    showLoading();
    currentUser = await api.login(username);
    localStorage.setItem('textme_user', JSON.stringify(currentUser));
    hideLoading();
    showApp();
  } catch (err) {
    hideLoading();
    showToast(err.message);
    loginBtn.disabled = false;
    loginBtn.textContent = 'Войти';
  }
});

/**
 * Обработчик выбора чата из списка.
 *
 * @param {string} chatId
 * @param {Object} chatData
 */
function handleChatSelect(chatId, chatData) {
  chatView.open(chatId, chatData);
}

/**
 * FAB — открыть модальное окно создания чата.
 */
fabNewChat.addEventListener('click', () => {
  newChatModal.classList.add('visible');
  newChatUsername.value = '';
  newChatUsername.focus();
});

/**
 * Модальное окно: отмена.
 */
modalCancel.addEventListener('click', () => {
  newChatModal.classList.remove('visible');
});

/**
 * Модальное окно: подтверждение создания чата.
 */
modalConfirm.addEventListener('click', handleCreateChat);

/**
 * Enter в поле модального окна.
 */
newChatUsername.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleCreateChat();
  }
});

/**
 * Создание нового чата.
 */
async function handleCreateChat() {
  const username = newChatUsername.value.trim();
  if (!username) return;

  modalConfirm.disabled = true;

  try {
    // 1. Находим/создаём пользователя по username
    const otherUser = await api.findUser(username);

    if (otherUser.id === currentUser.id) {
      showToast('Нельзя создать чат с самим собой');
      modalConfirm.disabled = false;
      return;
    }

    // 2. Создаём чат
    const chat = await api.createChat([currentUser.id, otherUser.id]);

    // Дополняем данные чата для UI
    chat.members = [
      { user_id: currentUser.id, username: currentUser.username, display_name: currentUser.display_name },
      { user_id: otherUser.id, username: otherUser.username, display_name: otherUser.display_name },
    ];

    // 3. Закрываем модал
    newChatModal.classList.remove('visible');

    // 4. Добавляем чат в список и открываем
    chatList.addChat(chat);
    chatView.open(chat.id, chat);
  } catch (err) {
    showToast(err.message);
  } finally {
    modalConfirm.disabled = false;
  }
}

/**
 * Выход из аккаунта.
 */
btnLogout.addEventListener('click', () => {
  localStorage.removeItem('textme_user');
  ws.disconnect();
  currentUser = null;
  app.classList.remove('active');
  showLogin();
});

/**
 * Клик по overlay модалки — закрытие.
 */
newChatModal.addEventListener('click', (e) => {
  if (e.target === newChatModal) {
    newChatModal.classList.remove('visible');
  }
});

// =============================================
// УТИЛИТЫ: Toast, Loading
// =============================================

/** Таймер toast-уведомления */
let toastTimer = null;

/**
 * Показать toast-уведомление.
 *
 * @param {string} message — текст уведомления
 * @param {number} [duration=3000] — длительность в мс
 */
function showToast(message, duration = 3000) {
  toastEl.textContent = message;
  toastEl.classList.add('visible');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('visible');
  }, duration);
}

/**
 * Показать overlay загрузки (cold start).
 */
function showLoading() {
  loadingOverlay.classList.add('visible');
}

/**
 * Скрыть overlay загрузки.
 */
function hideLoading() {
  loadingOverlay.classList.remove('visible');
}

// =============================================
// ЗАПУСК
// =============================================
bootstrap();
