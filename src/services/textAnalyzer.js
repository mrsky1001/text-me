/**
 * textAnalyzer.js — Базовый класс (интерфейс) анализатора текста.
 *
 * Все реализации (LanguageTool, LLM, нейросеть РФ) наследуют этот класс
 * и реализуют метод analyze(text).
 *
 * Паттерн Адаптер: позволяет подменять провайдера AI без изменения
 * остального кода (WebSocket pipeline, кэш, БД).
 */

class TextAnalyzer {
  /**
   * Анализировать текст на грамматические ошибки.
   *
   * @param {string} text — текст для анализа
   * @returns {Promise<{
   *   original: string,
   *   corrected: string,
   *   has_errors: boolean,
   *   errors: Array<{
   *     original: string,
   *     corrected: string,
   *     offset: number,
   *     length: number,
   *     rule: string,
   *     category: string,
   *     explanation: string
   *   }>,
   *   detected_language: string,
   *   provider: string,
   *   check_status: string
   * }>}
   * @throws {Error} — если метод не реализован в подклассе
   */
  async analyze(text) {
    throw new Error('Метод analyze() не реализован. Используйте конкретную реализацию.');
  }
}

module.exports = TextAnalyzer;
