/**
 * WebSocket Manager — реалтайм обмен сообщениями через Socket.IO.
 *
 * Подключается напрямую к HTTP-серверу Fastify (без fastify-socket.io,
 * т.к. он не совместим с Fastify 5).
 *
 * Обработчики событий:
 *   connection  — регистрация user_id → socket.id
 *   join_chat   — подписка на комнату chat:{chatId}
 *   send_message — сохранение в БД + мгновенная доставка (Optimistic UI)
 *   typing      — индикатор набора текста
 *   disconnect  — удаление из маппинга, рассылка offline
 */

const { Server } = require('socket.io');
const db = require('../db/index');
const LanguageToolAnalyzer = require('../services/languageToolAnalyzer');
const phraseCache = require('../services/phraseCache');

// Экземпляр анализатора текста (паттерн адаптера)
const analyzer = new LanguageToolAnalyzer();

// Маппинг онлайн-пользователей: user_id → socket.id
const onlineUsers = new Map();

// Ссылка на экземпляр Socket.IO сервера
let ioInstance = null;

/**
 * Инициализация Socket.IO на HTTP-сервере Fastify.
 * Вызывать ПОСЛЕ fastify.listen() — только тогда fastify.server доступен.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @returns {import('socket.io').Server}
 */
function setupSocketIO(fastify) {
  const io = new Server(fastify.server, {
    cors: {
      origin: true, // В продакшене заменить на конкретный домен
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    const userId = socket.handshake.query.user_id;

    if (!userId) {
      console.warn('[WS] Подключение без user_id — отклонено');
      socket.disconnect(true);
      return;
    }

    // Сохраняем маппинг
    onlineUsers.set(userId, socket.id);
    console.log(`[WS] Подключён: ${userId} (socket: ${socket.id}). Онлайн: ${onlineUsers.size}`);

    // ----- join_chat -----
    socket.on('join_chat', ({ chat_id }) => {
      if (!chat_id) return;
      const room = `chat:${chat_id}`;
      socket.join(room);
      console.log(`[WS] ${userId} вошёл в комнату ${room}`);
    });

    // ----- send_message -----
    socket.on('send_message', async ({ chat_id, text, local_id }) => {
      if (!chat_id || !text) return;

      try {
        // Сохраняем сообщение в БД
        const result = await db.query(
          `INSERT INTO messages (chat_id, sender_id, original_text, check_status)
           VALUES ($1, $2, $3, 'pending')
           RETURNING id, chat_id, sender_id, original_text, check_status, created_at`,
          [chat_id, userId, text]
        );

        const message = result.rows[0];

        // Подтверждение отправителю (Optimistic UI)
        socket.emit('msg_ack', {
          local_id,
          msg_id: message.id,
          status: 'sent',
        });

        // Рассылка всем в комнате (кроме отправителя)
        const room = `chat:${chat_id}`;
        socket.to(room).emit('new_msg', message);

        // Запускаем асинхронную AI-проверку (fire-and-forget)
        checkMessage(message.id, text, chat_id).catch((checkErr) => {
          console.error('[WS] Ошибка AI-проверки (не блокирует доставку):', checkErr.message);
        });
      } catch (err) {
        console.error('[WS] Ошибка send_message:', err.message);
        socket.emit('msg_error', {
          local_id,
          error: 'Не удалось сохранить сообщение',
        });
      }
    });

    // ----- typing -----
    socket.on('typing', ({ chat_id }) => {
      if (!chat_id) return;
      const room = `chat:${chat_id}`;
      socket.to(room).emit('user_typing', { user_id: userId, chat_id });
    });

    // ----- disconnect -----
    socket.on('disconnect', () => {
      onlineUsers.delete(userId);
      console.log(`[WS] Отключён: ${userId}. Онлайн: ${onlineUsers.size}`);

      // Рассылаем статус offline во все комнаты, в которых был сокет
      socket.rooms.forEach((room) => {
        if (room.startsWith('chat:')) {
          socket.to(room).emit('user_offline', { user_id: userId });
        }
      });
    });
  });

  // Сохраняем ссылку на io в модуле для доступа из других модулей
  ioInstance = io;

  console.log('[WS] Socket.IO инициализирован');
  return io;
}

/**
 * Асинхронная проверка текста сообщения через AI.
 * Вызывается fire-and-forget ПОСЛЕ доставки сообщения.
 *
 * 1. Проверяет кэш фраз
 * 2. Если промах — вызывает analyzer.analyze(text)
 * 3. Кэширует результат
 * 4. Обновляет запись в БД
 * 5. Рассылает msg_checked всем в комнате
 *
 * @param {string} msgId — UUID сообщения в БД
 * @param {string} text — текст для проверки
 * @param {string} chatId — UUID чата (для комнаты)
 */
async function checkMessage(msgId, text, chatId) {
  try {
    // 1. Проверяем кэш
    let result = phraseCache.get(text);

    if (!result) {
      // 2. Вызываем анализатор
      result = await analyzer.analyze(text);

      // 3. Кэшируем результат (если анализ удался)
      if (result.check_status !== 'error') {
        phraseCache.set(text, result);
      }
    }

    // 4. Обновляем запись в БД
    await db.query(
      `UPDATE messages
       SET check_status = $1,
           corrected_text = $2,
           has_errors = $3,
           correction_data = $4
       WHERE id = $5`,
      [
        result.check_status,
        result.corrected,
        result.has_errors,
        JSON.stringify({
          errors: result.errors,
          detected_language: result.detected_language,
          provider: result.provider,
          checked_at: new Date().toISOString(),
        }),
        msgId,
      ]
    );

    // 5. Рассылаем результат в комнату чата
    if (ioInstance) {
      const room = `chat:${chatId}`;
      ioInstance.to(room).emit('msg_checked', {
        msg_id: msgId,
        corrected_text: result.corrected,
        has_errors: result.has_errors,
        errors: result.errors,
        detected_language: result.detected_language,
        check_status: result.check_status,
      });
    }

    if (result.has_errors) {
      console.log(`[AI] Сообщение ${msgId.substring(0, 8)}... проверено: ${result.errors.length} ошибок`);
    }
  } catch (err) {
    console.error(`[AI] Ошибка проверки сообщения ${msgId}:`, err.message);

    // Обновляем статус ошибки в БД
    await db.query(
      `UPDATE messages SET check_status = 'error' WHERE id = $1`,
      [msgId]
    ).catch(() => {});
  }
}

/**
 * Получить экземпляр Socket.IO сервера.
 * @returns {import('socket.io').Server|null}
 */
function getIO() {
  return ioInstance;
}

/**
 * Получить Map онлайн-пользователей.
 * @returns {Map<string, string>}
 */
function getOnlineUsers() {
  return onlineUsers;
}

module.exports = { setupSocketIO, getIO, getOnlineUsers };
