import type { TelegramApiLike,TelegramReplyMarkup,TelegramParseMode } from '../types.ts';
export type MessageDelivery =
 | {kind:'sent';messageId:number|null}
 | {kind:'rate_limited';retryAfter:number}
 | {kind:'retryable'|'unknown'|'permanent'|'configuration';code:string};
/** Production TelegramApi supplies the structured API-confirmed result.
 * Structural test/adapter APIs must explicitly return success, never void/null. */
export async function deliverMessage(api:TelegramApiLike,chat:number,text:string,buttons?:TelegramReplyMarkup,parseMode?:TelegramParseMode):Promise<MessageDelivery>{
 try {
  if(api.sendMessageDelivery)return await api.sendMessageDelivery(chat,text,buttons,parseMode);
  const result=await api.sendMessage(chat,text,buttons,parseMode);
  if(result===true || (typeof result==='object'&&result!==null&&Number.isSafeInteger((result as {message_id?:unknown}).message_id)))
   return {kind:'sent',messageId:result===true?null:(result as {message_id:number}).message_id};
  return {kind:'unknown',code:'delivery_unconfirmed'};
 }catch{return {kind:'unknown',code:'delivery_transport_uncertain'};}
}
