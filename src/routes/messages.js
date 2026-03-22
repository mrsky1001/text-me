/**
 * Роуты сообщений.
 * GET /api/chats/:chatId/messages — история сообщений с cursor-пагинацией.
 */

const db = require('../db/index');

/**
 * Регистрация роутов сообщений.
 * @param {import('fastify').FastifyInstance} fastify
 */
async function messageRoutes(fastify) {
  /**
   * GET /api/chats/:chatId/messages
   * История сообщений чата с cursor-пагинацией.
   *
   * Params: chatId (UUID)
   * Query:
   *   - before (ISO datetime, опционально) — курсор для пагинации,
   *     возвращает сообщения ДО указанной даты
   *   - limit (число, по умолчанию 50, макс 50)
   *
   * Response: {
   *   messages: [{ id, chat_id, sender_id, sender_username, original_text, ... }],
   *   has_more: boolean,
   *   next_cursor: string|null
   * }
   */
  fastify.get('/api/chats/:chatId/messages', {
    schema: {
      params: {
        type: 'object',
        required: ['chatId'],
        properties: {
          chatId: { type: 'string', format: 'uuid' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          before: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 50 },
        },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    const { before, limit = 50 } = request.query;

    try {
      // Запрашиваем limit + 1, чтобы определить, есть ли ещё сообщения
      const fetchLimit = Math.min(limit, 50) + 1;

      let result;

      if (before) {
        // Cursor-пагинация: сообщения ДО указанной даты
        result = await db.query(
          `SELECT
             m.id,
             m.chat_id,
             m.sender_id,
             u.username AS sender_username,
             u.display_name AS sender_display_name,
             m.original_text,
             m.check_status,
             m.corrected_text,
             m.has_errors,
             m.correction_data,
             m.created_at
           FROM messages m
           INNER JOIN users u ON u.id = m.sender_id
           WHERE m.chat_id = $1
             AND m.created_at < $2
           ORDER BY m.created_at DESC
           LIMIT $3`,
          [chatId, before, fetchLimit]
        );
      } else {
        // Первая загрузка: последние N сообщений
        result = await db.query(
          `SELECT
             m.id,
             m.chat_id,
             m.sender_id,
             u.username AS sender_username,
             u.display_name AS sender_display_name,
             m.original_text,
             m.check_status,
             m.corrected_text,
             m.has_errors,
             m.correction_data,
             m.created_at
           FROM messages m
           INNER JOIN users u ON u.id = m.sender_id
           WHERE m.chat_id = $1
           ORDER BY m.created_at DESC
           LIMIT $2`,
          [chatId, fetchLimit]
        );
      }

      const rows = result.rows;
      const hasMore = rows.length > limit;

      // Убираем лишнюю запись (limit + 1)
      if (hasMore) {
        rows.pop();
      }

      // Определяем курсор для следующей страницы
      const nextCursor = hasMore && rows.length > 0
        ? rows[rows.length - 1].created_at.toISOString()
        : null;

      // Возвращаем сообщения в хронологическом порядке (от старых к новым)
      const messages = rows.reverse();

      // Подгружаем изображения для сообщений (если есть)
      if (messages.length > 0) {
        const msgIds = messages.map((m) => m.id);
        const imagesResult = await db.query(
          `SELECT
             id, message_id, storage_path, file_size, mime_type, width, height
           FROM message_images
           WHERE message_id = ANY($1::uuid[])
           ORDER BY created_at ASC`,
          [msgIds]
        );

        // Группируем изображения по message_id
        const imagesByMsg = {};
        for (const img of imagesResult.rows) {
          if (!imagesByMsg[img.message_id]) {
            imagesByMsg[img.message_id] = [];
          }
          imagesByMsg[img.message_id].push(img);
        }

        // Прикрепляем изображения к сообщениям
        for (const msg of messages) {
          msg.images = imagesByMsg[msg.id] || [];
        }
      }

      return reply.send({
        messages,
        has_more: hasMore,
        next_cursor: nextCursor,
      });
    } catch (err) {
      request.log.error(err, 'Ошибка загрузки сообщений');
      return reply.code(500).send({ error: 'Ошибка сервера при загрузке сообщений' });
    }
  });
}

module.exports = messageRoutes;
