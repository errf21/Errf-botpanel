/**
 * Shared e2e test harness: an in-memory SQLite D1 shim + a fetch stub that
 * records Telegram API calls (no network). Reused by phase2/phase3 tests.
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
  run(): void;
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
        stmt.run(...values);
        values = [];
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

export function messageUpdate(text: string, updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      from: USER,
      chat: { id: USER.id, type: 'private' },
      text,
    },
  };
}

export function callbackUpdate(data: unknown, updateId: number) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: USER,
      data,
      message: { message_id: 500, chat: { id: USER.id } },
    },
  };
}
