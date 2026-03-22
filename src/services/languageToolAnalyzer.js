/**
 * languageToolAnalyzer.js — Реализация TextAnalyzer для LanguageTool API.
 *
 * Отправляет текст на проверку в LanguageTool (публичный или self-hosted),
 * парсит ошибки, собирает исправленный текст.
 *
 * Русский текст пропускается без проверки (detected_language: 'ru').
 * При недоступности API — graceful degradation (check_status: 'error').
 */

const TextAnalyzer = require('./textAnalyzer');

/** URL LanguageTool API (из .env или публичный по умолчанию) */
const LT_API_URL = process.env.LANGUAGETOOL_URL || 'https://api.languagetoolplus.com/v2/check';

/** Таймаут запроса к LT API (мс) */
const LT_TIMEOUT = 10000;

/** Максимум повторных попыток при 5xx ошибках */
const MAX_RETRIES = 2;

/** Задержка между повторами (мс) */
const RETRY_DELAY = 3000;

class LanguageToolAnalyzer extends TextAnalyzer {
  /**
   * Анализировать текст через LanguageTool API.
   *
   * @param {string} text — текст для проверки
   * @returns {Promise<Object>} — результат анализа
   */
  async analyze(text) {
    if (!text || text.trim().length === 0) {
      return this._emptyResult(text);
    }

    // Пытаемся с повторами при 5xx ошибках
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this._doAnalyze(text);
      } catch (err) {
        const isServerError = err.statusCode && err.statusCode >= 500;
        const isLastAttempt = attempt === MAX_RETRIES;

        if (isServerError && !isLastAttempt) {
          console.warn(`[LT] Попытка ${attempt + 1}/${MAX_RETRIES + 1} провалилась (${err.statusCode}). Повтор через ${RETRY_DELAY}мс...`);
          await this._delay(RETRY_DELAY);
          continue;
        }

        // Конечная ошибка — graceful degradation
        console.error(`[LT] Ошибка анализа: ${err.message}`);
        return this._errorResult(text);
      }
    }

    return this._errorResult(text);
  }

  /**
   * Выполнить запрос к LanguageTool API и распарсить ответ.
   *
   * @param {string} text
   * @returns {Promise<Object>}
   * @private
   */
  async _doAnalyze(text) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LT_TIMEOUT);

    try {
      // LanguageTool принимает application/x-www-form-urlencoded
      const body = new URLSearchParams({
        text: text,
        language: 'en-US',
        enabledOnly: 'false',
      });

      const response = await fetch(LT_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = new Error(`LT API вернул ${response.status}`);
        err.statusCode = response.status;
        throw err;
      }

      const data = await response.json();
      return this._parseResponse(text, data);
    } catch (err) {
      if (err.name === 'AbortError') {
        const timeoutErr = new Error('LT API таймаут');
        timeoutErr.statusCode = 504;
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Парсинг ответа от LanguageTool API.
   *
   * @param {string} originalText — исходный текст
   * @param {Object} data — JSON ответ от LT
   * @returns {Object} — нормализованный результат
   * @private
   */
  _parseResponse(originalText, data) {
    // Проверяем определённый язык
    const detectedLang = data.language?.detectedLanguage?.code || '';

    // Если текст на русском — пропускаем проверку
    if (detectedLang.startsWith('ru')) {
      return {
        original: originalText,
        corrected: originalText,
        has_errors: false,
        errors: [],
        detected_language: 'ru',
        provider: 'languagetool',
        check_status: 'done',
      };
    }

    const matches = data.matches || [];

    if (matches.length === 0) {
      // Нет ошибок
      return {
        original: originalText,
        corrected: originalText,
        has_errors: false,
        errors: [],
        detected_language: detectedLang || 'en',
        provider: 'languagetool',
        check_status: 'done',
      };
    }

    // Обходим matches с конца в начало (чтобы offset не сбивались при замене)
    const errors = [];
    let correctedText = originalText;

    // Сначала собираем все ошибки
    for (const match of matches) {
      const offset = match.offset;
      const length = match.length;
      const originalFragment = originalText.substring(offset, offset + length);
      const replacement = match.replacements?.[0]?.value || originalFragment;

      errors.push({
        original: originalFragment,
        corrected: replacement,
        offset,
        length,
        rule: match.rule?.id || 'UNKNOWN',
        category: match.rule?.category?.name || 'Unknown',
        explanation: match.message || '',
      });
    }

    // Собираем corrected текст — идём с конца, чтобы не сбивать offset
    const sortedMatches = [...matches].sort((a, b) => b.offset - a.offset);
    for (const match of sortedMatches) {
      const replacement = match.replacements?.[0]?.value;
      if (replacement !== undefined) {
        correctedText =
          correctedText.substring(0, match.offset) +
          replacement +
          correctedText.substring(match.offset + match.length);
      }
    }

    return {
      original: originalText,
      corrected: correctedText,
      has_errors: true,
      errors,
      detected_language: detectedLang || 'en',
      provider: 'languagetool',
      check_status: 'done',
    };
  }

  /**
   * Результат для пустого текста.
   * @private
   */
  _emptyResult(text) {
    return {
      original: text || '',
      corrected: text || '',
      has_errors: false,
      errors: [],
      detected_language: 'unknown',
      provider: 'languagetool',
      check_status: 'skipped',
    };
  }

  /**
   * Результат при ошибке API (graceful degradation).
   * @private
   */
  _errorResult(text) {
    return {
      original: text,
      corrected: text,
      has_errors: false,
      errors: [],
      detected_language: 'unknown',
      provider: 'languagetool',
      check_status: 'error',
    };
  }

  /**
   * Промис-задержка.
   * @private
   */
  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = LanguageToolAnalyzer;
