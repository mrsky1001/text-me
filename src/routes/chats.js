/**
 * Роуты управления чатами.
 * POST /api/chats — создание чата между пользователями.
 * GET  /api/chats — список чатов пользователя с последним сообщением.
 */

const db = require('../db/index');

/**
 * Регистрация роутов чатов.
 * @param {import('fastify').FastifyInstance} fastify
 */
async function chatRoutes(fastify) {
  /**
   * POST /api/chats
   * Создание чата между пользователями.
   *
   * Body: { user_ids: string[] } — массив UUID пользователей
   * Response: { id, name, is_group, created_at, members: [...] }
   */
  fastify.post('/api/chats', {
    schema: {
      body: {
        type: 'object',
        required: ['user_ids'],
        properties: {
          user_ids: {
            type: 'array',
            minItems: 2,
            maxItems: 50,
            items: { type: 'string', format: 'uuid' },
          },
          name: { type: 'string', maxLength: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const { user_ids, name } = request.body;
    const isGroup = user_ids.length > 2;

    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // Для личных чатов (2 участника): проверяем, нет ли уже чата между ними
      if (!isGroup) {
        const existingChat = await client.query(
          `SELECT cm1.chat_id
           FROM chat_members cm1
           INNER JOIN chat_members cm2 ON cm1.chat_id = cm2.chat_id
           INNER JOIN chats c ON c.id = cm1.chat_id
           WHERE cm1.user_id = $1
             AND cm2.user_id = $2
             AND c.is_group = FALSE
           LIMIT 1`,
          [user_ids[0], user_ids[1]]
        );

        if (existingChat.rows.length > 0) {
          await client.query('ROLLBACK');

          // Возвращаем существующий чат
          const chatId = existingChat.rows[0].chat_id;
          const chatResult = await db.query(
            `SELECT c.id, c.name, c.is_group, c.created_at
             FROM chats c
             WHERE c.id = $1`,
            [chatId]
          );

          return reply.code(200).send(chatResult.rows[0]);
        }
      }

      // Создаём новый чат
      const chatResult = await client.query(
        `INSERT INTO chats (name, is_group)
         VALUES ($1, $2)
         RETURNING id, name, is_group, created_at`,
        [name || null, isGroup]
      );

      const chat = chatResult.rows[0];

      // Добавляем участников
      const memberValues = user_ids
        .map((_, i) => `($1, $${i + 2})`)
        .join(', ');
      const memberParams = [chat.id, ...user_ids];

      await client.query(
        `INSERT INTO chat_members (chat_id, user_id)
         VALUES ${memberValues}`,
        memberParams
      );

      await client.query('COMMIT');

      return reply.code(201).send(chat);
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error(err, 'Ошибка создания чата');
      return reply.code(500).send({ error: 'Ошибка сервера при создании чата' });
    } finally {
      client.release();
    }
  });

  /**
   * GET /api/chats?user_id=
   * Список чатов пользователя с последним сообщением.
   * Один оптимизированный SQL с JOIN + LATERAL для получения
   * последнего сообщения каждого чата.
   *
   * Query: user_id (UUID, обязательный)
   * Response: [{ id, name, is_group, created_at, last_message, members }]
   */
  fastify.get('/api/chats', {
    schema: {
      querystring: {
        type: 'object',
        required: ['user_id'],
        properties: {
          user_id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { user_id } = request.query;

    try {
      // Оптимизированный запрос:
      // 1. Находим все чаты пользователя через chat_members
      // 2. LATERAL JOIN для получения последнего сообщения каждого чата (LIMIT 1)
      // 3. Подзапрос для имён участников (для отображения в списке)
      const result = await db.query(
        `SELECT
           c.id,
           c.name,
           c.is_group,
           c.created_at,
           lm.last_msg_id,
           lm.last_msg_text,
           lm.last_msg_sender_id,
           lm.last_msg_created_at,
           (
             SELECT json_agg(json_build_object(
               'user_id', u.id,
               'username', u.username,
               'display_name', u.display_name
             ))
             FROM chat_members cm2
             INNER JOIN users u ON u.id = cm2.user_id
             WHERE cm2.chat_id = c.id
           ) AS members
         FROM chat_members cm
         INNER JOIN chats c ON c.id = cm.chat_id
         LEFT JOIN LATERAL (
           SELECT
             m.id AS last_msg_id,
             m.original_text AS last_msg_text,
             m.sender_id AS last_msg_sender_id,
             m.created_at AS last_msg_created_at
           FROM messages m
           WHERE m.chat_id = c.id
           ORDER BY m.created_at DESC
           LIMIT 1
         ) lm ON TRUE
         WHERE cm.user_id = $1
         ORDER BY COALESCE(lm.last_msg_created_at, c.created_at) DESC`,
        [user_id]
      );

      // Формируем ответ с вложенным объектом last_message
      const chats = result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        is_group: row.is_group,
        created_at: row.created_at,
        members: row.members || [],
        last_message: row.last_msg_id
          ? {
              id: row.last_msg_id,
              text: row.last_msg_text,
              sender_id: row.last_msg_sender_id,
              created_at: row.last_msg_created_at,
            }
          : null,
      }));

      return reply.send(chats);
    } catch (err) {
      request.log.error(err, 'Ошибка получения списка чатов');
      return reply.code(500).send({ error: 'Ошибка сервера при загрузке чатов' });
    }
  });
}

module.exports = chatRoutes;
