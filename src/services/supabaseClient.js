/**
 * Клиент Supabase для работы со Storage API.
 * Используется для загрузки и удаления изображений из бакета chat-images.
 *
 * ВАЖНО: клиент инициализируется лениво (при первом вызове getSupabase()),
 * чтобы не падать при require() до загрузки dotenv.
 */

const { createClient } = require('@supabase/supabase-js');

// Имя бакета для хранения изображений чата
const BUCKET_NAME = 'chat-images';

// Ленивая инициализация — клиент создаётся при первом обращении
let _supabase = null;

/**
 * Получение инициализированного клиента Supabase.
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
function getSupabase() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error(
        '[Supabase] SUPABASE_URL и SUPABASE_SERVICE_KEY должны быть заданы в .env'
      );
    }
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return _supabase;
}

/**
 * Загрузка файла в Supabase Storage.
 * @param {string} filePath — путь файла в бакете (напр. 'chat-uuid/image-uuid.jpg')
 * @param {Buffer} fileBuffer — содержимое файла
 * @param {string} mimeType — MIME-тип (image/jpeg, image/png, image/webp)
 * @returns {Promise<{path: string, error: Error|null}>}
 */
async function uploadFile(filePath, fileBuffer, mimeType) {
  const { data, error } = await getSupabase().storage
    .from(BUCKET_NAME)
    .upload(filePath, fileBuffer, {
      contentType: mimeType,
      upsert: false, // Не перезаписываем существующие файлы
    });

  if (error) {
    console.error('[Storage] Ошибка загрузки:', error.message);
    return { path: null, error };
  }

  return { path: data.path, error: null };
}

/**
 * Удаление файлов из Supabase Storage.
 * @param {string[]} filePaths — массив путей файлов в бакете
 * @returns {Promise<{deleted: number, error: Error|null}>}
 */
async function deleteFiles(filePaths) {
  if (!filePaths || filePaths.length === 0) {
    return { deleted: 0, error: null };
  }

  const { data, error } = await getSupabase().storage
    .from(BUCKET_NAME)
    .remove(filePaths);

  if (error) {
    console.error('[Storage] Ошибка удаления файлов:', error.message);
    return { deleted: 0, error };
  }

  return { deleted: data?.length || 0, error: null };
}

/**
 * Получение публичного URL файла из Storage.
 * @param {string} filePath — путь файла в бакете
 * @returns {string}
 */
function getPublicUrl(filePath) {
  const { data } = getSupabase().storage
    .from(BUCKET_NAME)
    .getPublicUrl(filePath);

  return data.publicUrl;
}

module.exports = {
  getSupabase,
  BUCKET_NAME,
  uploadFile,
  deleteFiles,
  getPublicUrl,
};
