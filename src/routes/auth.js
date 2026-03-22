/**
 * Роуты авторизации (псевдо-авторизация по username).
 * POST /api/users — создание/вход пользователя (upsert).
 */

const db = require('../db/index');

/**
 * Регистрация роутов авторизации.
 * @param {import('fastify').FastifyInstance} fastify
 */
async function authRoutes(fastify) {
  /**
   * POST /api/users
   * Создание пользователя или вход по username (upsert).
   *
   * Body: { username: string, display_name?: string }
   * Response: { id, username, display_name, native_lang, target_lang, created_at }
   */
  fastify.post('/api/users', {
    schema: {
      body: {
        type: 'object',
        required: ['username'],
        properties: {
          username: { type: 'string', minLength: 2, maxLength: 50 },
          display_name: { type: 'string', maxLength: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const { username, display_name } = request.body;

    // Нормализуем username (lowercase, trim)
    const normalizedUsername = username.trim().toLowerCase();

    try {
      // UPSERT: если пользователь существует — возвращаем его,
      // если нет — создаём нового
      const result = await db.query(
        `INSERT INTO users (username, display_name)
         VALUES ($1, $2)
         ON CONFLICT (username) DO UPDATE
           SET display_name = COALESCE(NULLIF($2, ''), users.display_name)
         RETURNING id, username, display_name, native_lang, target_lang, created_at`,
        [normalizedUsername, display_name || normalizedUsername]
      );

      const user = result.rows[0];
      return reply.code(200).send(user);
    } catch (err) {
      request.log.error(err, 'Ошибка создания/входа пользователя');
      return reply.code(500).send({ error: 'Ошибка сервера при создании пользователя' });
    }
  });
}

module.exports = authRoutes;
