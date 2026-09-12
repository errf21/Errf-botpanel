import type {
  TelegramApiLike,
  TelegramInlineKeyboardMarkup,
} from '../types.ts';

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

/**
 * Minimal Telegram Bot API client.
 * Logs method names and Telegram's own status/description only —
 * never the token, message text, or callback payloads.
 */
export class TelegramApi implements TelegramApiLike {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  private async call<T>(
    method: 'sendMessage' | 'editMessageText' | 'answerCallbackQuery',
    payload: Record<string, unknown>,
  ): Promise<T | null> {
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.#token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      console.error(`telegram_api_network_error method=${method}`);
      return null;
    }

    let parsed: TgResponse<T> | null = null;
    try {
      parsed = (await response.json()) as TgResponse<T>;
    } catch {
      parsed = null;
    }

    if (parsed?.ok) return parsed.result ?? null;

    // No-op callback edits are benign; anything else gets a sanitized one-line log.
    const description = parsed?.description ?? 'unknown';
    if (!(method === 'editMessageText' && description.includes('not modified'))) {
      console.error(
        `telegram_api_error method=${method} code=${String(parsed?.error_code ?? response.status)} description=${description}`,
      );
    }
    return null;
  }

  sendMessage(
    chatId: number,
    text: string,
    buttons?: TelegramInlineKeyboardMarkup,
  ): Promise<null> {
    return this.call<null>('sendMessage', {
      chat_id: chatId,
      text,
      ...(buttons ? { reply_markup: buttons } : {}),
    });
  }

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    buttons?: TelegramInlineKeyboardMarkup,
  ): Promise<null> {
    return this.call<null>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(buttons ? { reply_markup: buttons } : {}),
    });
  }

  async answerCallbackQuery(
    id: string,
    text?: string,
    showAlert = false,
  ): Promise<void> {
    await this.call<true>('answerCallbackQuery', {
      callback_query_id: id,
      ...(text ? { text, show_alert: showAlert } : {}),
    });
  }
}
