import type {MessageDelivery} from './delivery.ts';
import {limitedText} from '../panels/http.ts';
import type {
  TelegramApiLike,
  TelegramInlineKeyboardMarkup,
  TelegramParseMode,
  TelegramReplyMarkup,
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
    method:
      | 'sendMessage'
      | 'sendPhoto'
      | 'sendDocument'
      | 'editMessageText'
      | 'editMessageCaption'
      | 'answerCallbackQuery'
      | 'getMe',
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
    const description = typeof parsed?.description==='string' ? parsed.description : '';
    const reported=parsed?.error_code;
    const code=typeof reported==='number' && Number.isInteger(reported) && reported>=100 && reported<=599 ? reported : response.status;
    const benignEditMiss =
      (method === 'editMessageText' || method === 'editMessageCaption') &&
      (description.includes('not modified') ||
        description.includes('message to edit not found') ||
        description.includes("there is no caption"));
    if (!benignEditMiss) {
      console.error(
        `telegram_api_error method=${method} code=${code}`,
      );
    }
    return null;
  }

  /** Bounded, classified transport for recoverable delivery jobs only. Never
   * logs upstream descriptions, request bodies, token URLs or raw exceptions. */
  async sendMessageDelivery(chatId:number,text:string,buttons?:TelegramReplyMarkup,parseMode?:TelegramParseMode):Promise<MessageDelivery>{
    let response:Response;
    try {
      response=await fetch(`https://api.telegram.org/bot${this.#token}/sendMessage`,{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
        headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text,
          ...(buttons?{reply_markup:buttons}:{}),...(parseMode?{parse_mode:parseMode}:{})})});
    }catch{return {kind:'unknown',code:'telegram_transport_uncertain'};}
    let data:{ok?:unknown;result?:{message_id?:unknown};error_code?:number;parameters?:{retry_after?:unknown}}|null=null;
    try{data=JSON.parse(await limitedText(response,131072));}catch{}
    if(response.ok&&data?.ok===true&&Number.isSafeInteger(data.result?.message_id)&&Number(data.result?.message_id)>0)
      return {kind:'sent',messageId:Number(data.result!.message_id)};
    const code=data?.error_code??response.status;
    if(code===429){const n=Number(data?.parameters?.retry_after);return {kind:'rate_limited',retryAfter:Number.isSafeInteger(n)&&n>0?n:60};}
    if(code===401)return {kind:'configuration',code:'telegram_auth_unavailable'};
    if(code===400||code===403||code===404)return {kind:'permanent',code:'telegram_recipient_rejected'};
    if(code>=500)return {kind:'retryable',code:'telegram_unavailable'};
    return {kind:'unknown',code:'telegram_response_unverified'};
  }

  sendMessage(
    chatId: number,
    text: string,
    buttons?: TelegramReplyMarkup,
    parseMode?: TelegramParseMode,
  ): Promise<null> {
    return this.call<null>('sendMessage', {
      chat_id: chatId,
      text,
      ...(buttons ? { reply_markup: buttons } : {}),
      ...(parseMode ? { parse_mode: parseMode } : {}),
    });
  }

  async sendPhoto(
    chatId: number,
    fileId: string,
    caption: string,
    buttons?: TelegramInlineKeyboardMarkup,
  ): Promise<boolean> {
    const result = await this.call<Record<string, unknown>>('sendPhoto', {
      chat_id: chatId,
      photo: fileId,
      caption,
      ...(buttons ? { reply_markup: buttons } : {}),
    });
    return result !== null;
  }

  async sendDocument(
    chatId: number,
    fileId: string,
    caption: string,
    buttons?: TelegramInlineKeyboardMarkup,
  ): Promise<boolean> {
    const result = await this.call<Record<string, unknown>>('sendDocument', {
      chat_id: chatId,
      document: fileId,
      caption,
      ...(buttons ? { reply_markup: buttons } : {}),
    });
    return result !== null;
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    buttons?: TelegramInlineKeyboardMarkup,
    parseMode?: TelegramParseMode,
  ): Promise<boolean> {
    const result = await this.call<Record<string, unknown>>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(buttons ? { reply_markup: buttons } : {}),
      ...(parseMode ? { parse_mode: parseMode } : {}),
    });
    return result !== null;
  }

  /** True only when Telegram accepted the caption edit (media messages). */
  async editMessageCaption(
    chatId: number,
    messageId: number,
    caption: string,
    buttons?: TelegramInlineKeyboardMarkup,
  ): Promise<boolean> {
    const result = await this.call<Record<string, unknown>>('editMessageCaption', {
      chat_id: chatId,
      message_id: messageId,
      caption,
      ...(buttons ? { reply_markup: buttons } : {}),
    });
    return result !== null;
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

  /** Bot identity for invite links (Phase 7). Null on any failure. */
  async getMe(): Promise<Record<string, unknown> | null> {
    return this.call<Record<string, unknown>>('getMe', {});
  }
}
