/**
 * Роуты загрузки изображений.
 * POST /api/chats/:chatId/images — загрузка изображения в чат.
 *
 * Ограничения:
 * - Максимальный размер: 10 МБ (10485760 байт)
 * - Допустимые форматы: JPEG, PNG, WebP
 * - Файлы хранятся в Supabase Storage, бакет 'chat-images'
 * - Автоудаление через RETENTION_DAYS_IMAGES дней
 */

const crypto = require('crypto');
const db = require('../db/index');
const { uploadFile, getPublicUrl } = require('../services/supabaseClient');

// Допустимые MIME-типы для изображений
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

// Максимальный размер файла: 10 МБ
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Регистрация роутов изображений.
 * @param {import('fastify').FastifyInstance} fastify
 */
async function imageRoutes(fastify) {
  /**
   * POST /api/chats/:chatId/images
   * Загрузка изображения в чат.
   *
   * Content-Type: multipart/form-data
   * Поля:
   *   - file: файл изображения
   *   - message_id: UUID сообщения (если прикреплено к существующему)
   *   - sender_id: UUID отправителя
   *
   * Response: { image_id, storage_path, public_url, file_size, mime_type }
   */
  fastify.post('/api/chats/:chatId/images', {
    schema: {
      params: {
        type: 'object',
        required: ['chatId'],
        properties: {
          chatId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;

    try {
      // Получаем файл из multipart-запроса
      const data = await request.file();

      if (!data) {
        return reply.code(400).send({ error: 'Файл не передан' });
      }

      // Проверяем MIME-тип
      if (!ALLOWED_MIME_TYPES.has(data.mimetype)) {
        return reply.code(400).send({
          error: `Недопустимый формат файла: ${data.mimetype}. Разрешены: JPEG, PNG, WebP`,
        });
      }

      // Читаем файл в буфер
      const chunks = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const fileBuffer = Buffer.concat(chunks);

      // Проверяем размер файла
      if (fileBuffer.length > MAX_FILE_SIZE) {
        return reply.code(400).send({
          error: `Файл слишком большой: ${(fileBuffer.length / 1024 / 1024).toFixed(1)} МБ. Максимум: 10 МБ`,
        });
      }

      // Получаем sender_id и message_id из полей формы
      const fields = data.fields;
      const senderId = fields.sender_id?.value;
      const messageId = fields.message_id?.value;

      if (!senderId) {
        return reply.code(400).send({ error: 'Не указан sender_id' });
      }

      // Генерируем уникальное имя файла
      const fileExt = data.mimetype.split('/')[1] === 'jpeg' ? 'jpg' : data.mimetype.split('/')[1];
      const uniqueName = `${crypto.randomUUID()}.${fileExt}`;
      const storagePath = `${chatId}/${uniqueName}`;

      // Загружаем в Supabase Storage
      const { path: uploadedPath, error: uploadError } = await uploadFile(
        storagePath,
        fileBuffer,
        data.mimetype
      );

      if (uploadError) {
        return reply.code(500).send({ error: 'Ошибка загрузки файла в хранилище' });
      }

      // Вычисляем TTL для автоудаления
      const retentionDays = parseInt(process.env.RETENTION_DAYS_IMAGES, 10) || 3;

      // Если message_id не указан, создаём служебное сообщение
      let finalMessageId = messageId;
      if (!finalMessageId) {
        const msgResult = await db.query(
          `INSERT INTO messages (chat_id, sender_id, original_text, check_status)
           VALUES ($1, $2, '[изображение]', 'skipped')
           RETURNING id`,
          [chatId, senderId]
        );
        finalMessageId = msgResult.rows[0].id;
      }

      // Создаём запись в message_images
      const imageResult = await db.query(
        `INSERT INTO message_images (message_id, storage_path, file_size, mime_type, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::INTERVAL)
         RETURNING id, storage_path, file_size, mime_type, created_at, expires_at`,
        [finalMessageId, storagePath, fileBuffer.length, data.mimetype, retentionDays.toString()]
      );

      const image = imageResult.rows[0];
      const publicUrl = getPublicUrl(storagePath);

      return reply.code(201).send({
        image_id: image.id,
        message_id: finalMessageId,
        storage_path: image.storage_path,
        public_url: publicUrl,
        file_size: image.file_size,
        mime_type: image.mime_type,
        created_at: image.created_at,
        expires_at: image.expires_at,
      });
    } catch (err) {
      request.log.error(err, 'Ошибка загрузки изображения');
      return reply.code(500).send({ error: 'Ошибка сервера при загрузке изображения' });
    }
  });
}

module.exports = imageRoutes;
