/**
 * Shared e2e test harness: an in-memory SQLite D1 shim + a fetch stub that
 * records Telegram API calls (no network). Reused by phase2/3/4 tests.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export interface Sent {
  method: string;
  text?: unknown;
  payload: Record<string, unknown>;
}

export function makeFetchStub() {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.match(/\/bot[^/]+\/(\w+)$/)?.[1] ?? 'unknown';
    const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({
      method,
      text: payload['text'],
      payload: { chat_id: payload['chat_id'], ...payload },
    });
    return Response.json({ ok: true, result: {} });
  }) as typeof fetch;
  return {
    sent,
    reset: () => {
      sent.length = 0;
    },
    restore: () => {
      globalThis.fetch = real;
    },
    sendCalls: () => sent.filter((s) => s.method === 'sendMessage'),
  };
}

interface ShimStatement {
  bind(...values: unknown[]): ShimStatement;
  run(): { meta: { changes: number } };
  first<T extends object>(): T | null;
  all<T extends object>(): { results: T[] };
  // batch support:
  __exec(): void;
}

export function makeD1Shim(db: DatabaseSync) {
  function prepare(sql: string): ShimStatement {
    const stmt = db.prepare(sql);
    let values: unknown[] = [];
    const api: ShimStatement = {
      bind(...args: unknown[]) {
        values = args;
        return api;
      },
      run() {
        const out = stmt.run(...values) as { changes?: number };
        values = [];
        // Mirrors D1's D1Result.meta.changes for guarded UPDATE verification.
        return { meta: { changes: Number(out.changes ?? 0) } };
      },
      first<T extends object>() {
        const row = stmt.get(...values) as T | undefined;
        values = [];
        return row ?? null;
      },
      all<T extends object>() {
        const results = stmt.all(...values) as T[];
        values = [];
        return { results };
      },
      __exec() {
        stmt.run(...values);
        values = [];
      },
    };
    return api;
  }

  return {
    prepare,
    async batch(statements: ShimStatement[]): Promise<unknown[]> {
      // Mirrors D1 batch semantics: sequential, stops on first failure.
      const results: unknown[] = [];
      for (const statement of statements) {
        statement.__exec();
        results.push({ success: true });
      }
      return results;
    },
  };
}

export function freshDb(): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of [
    'migrations/0001_init.sql',
    'migrations/0002_phase2.sql',
    'migrations/0003_phase3.sql',
    'migrations/0004_phase4.sql',
  ]) {
    sqlite.exec(readFileSync(`${here}../${file}`, 'utf8'));
  }
  return sqlite;
}

export const USER = {
  id: 987654321,
  first_name: 'Ali',
  username: 'ali_dev',
  language_code: 'fa',
};

export const ADMIN = {
  id: 111111111,
  first_name: 'Sara',
  username: 'sara_admin',
  language_code: 'fa',
};

export function messageUpdate(text: string, updateId: number) {
  return messageUpdateAs(USER, text, updateId);
}

export function messageUpdateAs(
  user: typeof USER,
  text: string,
  updateId: number,
  messageIdOffset = 100,
) {
  return {
    update_id: updateId,
    message: {
      message_id: messageIdOffset + updateId,
      from: user,
      chat: { id: user.id, type: 'private' },
      text,
    },
  };
}

/** Photo or document uploads for the receipt flow. */
export function mediaUpdate(
  updateId: number,
  receipt: { kind: 'photo' | 'document'; fileId: string; caption?: string },
  user: typeof USER = USER,
) {
  const media =
    receipt.kind === 'photo'
      ? { photo: [{ file_id: `${receipt.fileId}_small` }, { file_id: receipt.fileId }] }
      : { document: { file_id: receipt.fileId } };
  return {
    update_id: updateId,
    message: {
      message_id: 200 + updateId,
      from: user,
      chat: { id: user.id, type: 'private' },
      ...(receipt.caption ? { caption: receipt.caption } : {}),
      ...media,
    },
  };
}

export function callbackUpdate(data: unknown, updateId: number) {
  return callbackUpdateAs(data, updateId, USER);
}

export function callbackUpdateAs(
  data: unknown,
  updateId: number,
  user: typeof USER,
  messageChatId?: number,
) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: user,
      data,
      message: {
        message_id: 500 + updateId,
        chat: { id: messageChatId ?? user.id },
      },
    },
  };
}
