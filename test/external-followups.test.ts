/**
 * M8.1 follow-ups (ADR 0011): freshness of materialized views over external data
 * (`REFRESH … IF CHANGED`), refresh policies run by the engine server, credential callbacks across
 * the worker boundary, and export over external data.
 */
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Database, MemoryVfs } from 'smaltdb/engine';
import { EngineServer } from 'smaltdb-src/engine/server.js';
import io from '@smaltdb/io';
import { exportCSV } from '@smaltdb/io/client';
import external from '../src/index.js';
import { type FetchFn, registerCredentials, registerFile, setFetch } from '../src/client.js';
import type { Request, Response } from 'smaltdb-src/shared/protocol.js';
import { until } from './helpers/wait.js';

const plugins = [external, io];

const errorOf = async (p: Promise<unknown> | (() => unknown)): Promise<{ code: string; message: string }> => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return { code: (e as { code: string }).code, message: (e as Error).message };
  }
  throw new Error('expected an error');
};

/** An HTTP source whose body and ETag the test changes; records method + URL + headers of each request. */
function source() {
  const s = { body: 'a\n1\n2\n', etag: '"v1"' as string | null, calls: [] as string[], headers: [] as Record<string, string>[], fail: false };
  const fetch: FetchFn = async (url, init) => {
    s.calls.push(`${init.method ?? 'GET'} ${url}`);
    s.headers.push(init.headers);
    if (s.fail) throw new TypeError('network down');
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (h: string) => (h === 'etag' ? s.etag : null) },
      arrayBuffer: async () => new TextEncoder().encode(init.method === 'HEAD' ? '' : s.body).buffer as ArrayBuffer,
    };
  };
  return { s, fetch };
}

describe('REFRESH MATERIALIZED VIEW … IF CHANGED', () => {
  it('revalidates HTTP sources with HEAD and refreshes only when the ETag changed', async () => {
    const vfs = new MemoryVfs();
    const db = await Database.open(vfs, 'db', { plugins });
    const { s, fetch } = source();
    await setFetch(db, fetch);
    await db.execAsync("CREATE EXTERNAL TABLE e WITH (location = 'https://h/a.csv'); CREATE MATERIALIZED VIEW m AS SELECT sum(a) AS t FROM e");
    s.calls.length = 0;
    await db.execAsync('REFRESH MATERIALIZED VIEW m IF CHANGED');
    expect(s.calls).toEqual(['HEAD https://h/a.csv']);
    s.body = 'a\n10\n';
    s.etag = '"v2"';
    s.calls.length = 0;
    await db.execAsync('REFRESH MATERIALIZED VIEW m IF CHANGED');
    expect(s.calls).toEqual(['HEAD https://h/a.csv', 'GET https://h/a.csv']);
    expect(db.query('SELECT t FROM m').rows).toEqual([[10]]);
    // The validators are stored: after reopening, an unchanged source is still not downloaded.
    db.close();
    const again = await Database.open(vfs, 'db', { plugins });
    await setFetch(again, fetch);
    s.calls.length = 0;
    await again.execAsync('REFRESH MATERIALIZED VIEW m IF CHANGED');
    expect(s.calls).toEqual(['HEAD https://h/a.csv']);
    // A source without a validator always counts as changed.
    s.etag = null;
    s.calls.length = 0;
    await again.execAsync('REFRESH MATERIALIZED VIEW m IF CHANGED');
    expect(s.calls).toEqual(['HEAD https://h/a.csv', 'GET https://h/a.csv']);
    // System table, cleaned up with the view.
    expect((await errorOf(() => again.exec('DELETE FROM smalt_extcache'))).message).toMatch(/may not be modified/);
    again.exec('DROP MATERIALIZED VIEW m');
    expect(again.query('SELECT count(*) FROM smalt_extcache').rows).toEqual([[0]]);
    expect(again.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('uses file modification times, File.lastModified, and always refreshes registered bytes', async () => {
    const db = await Database.open(new MemoryVfs(), 'db', { plugins });
    const path = join(mkdtempSync(join(tmpdir(), 'smaltdb-fresh-')), 'n.csv');
    writeFileSync(path, 'n\n1\n');
    utimesSync(path, 1_000, 1_000);
    await registerFile(db, 'f', new File(['n\n2\n'], 'f.csv', { lastModified: 5_000 }));
    await registerFile(db, 'b', 'n\n3\n');
    await db.execAsync(`CREATE MATERIALIZED VIEW m AS SELECT (SELECT n FROM read_csv('${path}')) AS p, (SELECT n FROM read_csv('file:f', format => 'csv')) AS f`);
    await db.execAsync("CREATE MATERIALIZED VIEW mb AS SELECT n FROM read_csv('file:b', format => 'csv')");
    const refreshedAt = () => db.query("SELECT table_name, last_refresh FROM information_schema.materialized_views ORDER BY 1").rows;
    const before = refreshedAt();
    await until('the clock to move', () => new Date().toISOString() !== before[0][1]);
    await db.execAsync('REFRESH MATERIALIZED VIEW m IF CHANGED; REFRESH MATERIALIZED VIEW mb IF CHANGED');
    const after = refreshedAt();
    expect(after[0]).toEqual(before[0]); // m: nothing changed
    expect(after[1][1]).not.toBe(before[1][1]); // mb: bytes have no validator
    writeFileSync(path, 'n\n9\n');
    utimesSync(path, 2_000, 2_000);
    await db.execAsync('REFRESH MATERIALIZED VIEW m IF CHANGED');
    expect(db.query('SELECT p, f FROM m').rows).toEqual([[9, 2]]);
    await registerFile(db, 'f', new File(['n\n7\n'], 'f.csv', { lastModified: 6_000 }));
    await db.execAsync('REFRESH MATERIALIZED VIEW m IF CHANGED');
    expect(db.query('SELECT p, f FROM m').rows).toEqual([[9, 7]]);
  });

  it('refreshes a view over local data only when it is stale; needs the async API', async () => {
    const db = await Database.open(new MemoryVfs(), 'db', { plugins });
    db.exec('CREATE TABLE t(x INT); INSERT INTO t VALUES (1); CREATE MATERIALIZED VIEW c AS SELECT count(*) AS n FROM t');
    const at = () => db.query('SELECT last_refresh FROM information_schema.materialized_views').rows[0][0];
    const first = at();
    await until('the clock to move', () => new Date().toISOString() !== first);
    await db.execAsync('REFRESH MATERIALIZED VIEW c IF CHANGED');
    expect(at()).toBe(first);
    db.exec('INSERT INTO t VALUES (2)');
    await db.execAsync('REFRESH MATERIALIZED VIEW c IF CHANGED');
    expect(db.query('SELECT n FROM c').rows).toEqual([[2]]);
    expect((await errorOf(() => db.exec('REFRESH MATERIALIZED VIEW c IF CHANGED'))).code).toBe('SMALT_ASYNC_REQUIRED');
  });
});

describe('refresh policies (engine server)', () => {
  async function setup() {
    const db = await Database.open(new MemoryVfs(), 'db', { plugins });
    const src = source();
    await setFetch(db, src.fetch);
    const log: { session: string; msg: Response }[] = [];
    const server = new EngineServer((session, msg) => log.push({ session, msg }), { open: () => db, refreshTimer: false });
    let id = 1;
    const send = (body: Record<string, unknown>, session = EngineServer.LOCAL): number => {
      const rid = id++;
      server.receive(session, { ...body, id: rid } as Request);
      return rid;
    };
    const done = async (rid: number) => {
      await until(`request ${rid}`, () => log.some((m) => m.msg.id === rid && (m.msg.kind === 'ok' || m.msg.kind === 'error' || m.msg.kind === 'done')));
      return log.find((m) => m.msg.id === rid && m.msg.kind === 'error')?.msg;
    };
    await done(send({ op: 'open', name: 'db', storage: 'memory' }));
    return { db, server, send, done, log, ...src };
  }

  it('refresh_every: due views refresh through the queue; errors show in information_schema', async () => {
    const t = await setup();
    expect(await t.done(t.send({ op: 'exec', sql: "CREATE EXTERNAL TABLE e WITH (location = 'https://h/a.csv'); CREATE MATERIALIZED VIEW m WITH (refresh_every = 60) AS SELECT sum(a) AS s FROM e" }))).toBeUndefined();
    const info = () => t.db.query('SELECT refresh_mode, last_refresh_error FROM information_schema.materialized_views').rows[0];
    expect(info()).toEqual(['EVERY 60 SECONDS', null]);
    const now = Date.now();
    t.s.calls.length = 0;
    t.server.refreshTick(now + 30_000); // not due
    t.server.refreshTick(now + 61_000);
    t.server.refreshTick(now + 61_500); // already queued: once
    await until('the check', () => t.s.calls.length > 0);
    t.s.etag = '"v2"';
    t.s.body = 'a\n100\n';
    t.server.refreshTick(now + 200_000);
    await until('the refresh', () => t.db.query('SELECT s FROM m').rows[0][0] === 100);
    expect(t.s.calls).toEqual(['HEAD https://h/a.csv', 'HEAD https://h/a.csv', 'GET https://h/a.csv']);
    t.s.fail = true;
    t.server.refreshTick(now + 400_000);
    await until('the error', () => info()[1] !== null);
    expect(info()[1]).toMatch(/network down/);
    t.s.fail = false;
    t.s.etag = '"v3"';
    t.server.refreshTick(now + 600_000);
    await until('the error to clear', () => info()[1] === null);
    // Responses to the server's own requests go to no session.
    expect(t.log.every((m) => m.session === EngineServer.LOCAL)).toBe(true);
  });

  it('refresh_on_reconnect, and option checks', async () => {
    const t = await setup();
    await t.done(t.send({ op: 'exec', sql: "CREATE EXTERNAL TABLE e WITH (location = 'https://h/a.csv'); CREATE MATERIALIZED VIEW m WITH (refresh_on_reconnect = true) AS SELECT sum(a) AS s FROM e" }));
    expect(t.db.query('SELECT refresh_mode FROM information_schema.materialized_views').rows).toEqual([['ON RECONNECT']]);
    t.s.etag = '"v2"';
    t.s.body = 'a\n5\n';
    t.server.refreshTick(Date.now() + 10_000_000); // no refresh_every: never on the clock
    t.server.reconnected();
    await until('the refresh', () => t.db.query('SELECT s FROM m').rows[0][0] === 5);
    expect(await t.done(t.send({ op: 'exec', sql: 'CREATE MATERIALIZED VIEW x WITH (refresh_every = 0) AS SELECT 1' }))).toMatchObject({ message: 'refresh_every must be a positive number of seconds' });
  });
});

describe('credential callbacks across the worker boundary', () => {
  it('the engine asks the registering session for headers, per request', async () => {
    const db = await Database.open(new MemoryVfs(), 'db', { plugins });
    const src = source();
    await setFetch(db, src.fetch);
    const log: { session: string; msg: Response }[] = [];
    const server = new EngineServer((session, msg) => log.push({ session, msg }), { open: () => db, refreshTimer: false });
    let id = 1;
    const send = (body: Record<string, unknown>, session: string): number => {
      const rid = id++;
      server.receive(session, { ...body, id: rid } as Request);
      return rid;
    };
    const result = async (rid: number) => {
      await until(`request ${rid}`, () => log.some((m) => m.msg.id === rid && (m.msg.kind === 'ok' || m.msg.kind === 'error' || m.msg.kind === 'done')));
      return log.find((m) => m.msg.id === rid && m.msg.kind === 'error')?.msg;
    };
    // A client answering credentials questions as the client library does.
    let token = 1;
    const answer = (session: string, refuse = false) => {
      for (const m of log) {
        if (m.session !== session || m.msg.kind !== 'pluginAsk' || (m as { answered?: boolean }).answered) continue;
        (m as { answered?: boolean }).answered = true;
        const q = m.msg;
        const url = (q.message as { url: string }).url;
        server.receive(session, { id: 0, op: 'pluginReply', target: q.request, ...(refuse ? { error: 'signed out' } : { value: { headers: { authorization: `Bearer t${token++}`, 'x-url': url } } }) } as Request);
      }
    };
    await result(send({ op: 'open', name: 'db', storage: 'memory' }, EngineServer.LOCAL));
    await result(send({ op: 'pluginCall', plugin: '@smaltdb/external', method: 'registerCredentials', args: ['tok', { endpoint: 'https://h/', callback: true }] }, 'tab-2'));
    await result(send({ op: 'exec', sql: "CREATE CONNECTION c WITH (url = 'https://h', credentials = 'tok'); CREATE EXTERNAL TABLE e (a INT) WITH (connection = 'c', location = 'a.csv')" }, EngineServer.LOCAL));
    const q1 = send({ op: 'query', sql: 'SELECT sum(a) FROM e' }, EngineServer.LOCAL);
    await until('the question', () => log.some((m) => m.msg.kind === 'pluginAsk'));
    expect(log.find((m) => m.msg.kind === 'pluginAsk')).toMatchObject({ session: 'tab-2', msg: { plugin: '@smaltdb/external', message: { name: 'tok', url: 'https://h/a.csv', method: 'GET' } } });
    answer('tab-2');
    expect(await result(q1)).toBeUndefined();
    expect(src.s.headers.at(-1)).toEqual({ authorization: 'Bearer t1', 'x-url': 'https://h/a.csv' });
    // Fresh headers for every request; a refusal fails the query with the provider's reason.
    const q2 = send({ op: 'query', sql: 'SELECT sum(a) FROM e' }, EngineServer.LOCAL);
    await until('the second question', () => log.filter((m) => m.msg.kind === 'pluginAsk').length === 2);
    answer('tab-2', true);
    expect(await result(q2)).toMatchObject({ code: 'SMALT_EXTERNAL', message: "e: credentials 'tok': signed out" });
    // The providing tab closes: a waiting question fails at once, and its credentials are gone.
    const q3 = send({ op: 'query', sql: 'SELECT sum(a) FROM e' }, EngineServer.LOCAL);
    await until('the third question', () => log.filter((m) => m.msg.kind === 'pluginAsk').length === 3);
    server.sessionGone('tab-2');
    expect(await result(q3)).toMatchObject({ message: "e: credentials 'tok': the tab that provides them closed" });
    expect(await result(send({ op: 'query', sql: 'SELECT sum(a) FROM e' }, EngineServer.LOCAL))).toMatchObject({ message: /no credentials are registered as 'tok'/ });
  });

  it('the client helper keeps functions in the tab and answers the questions', async () => {
    const db = await Database.open(new MemoryVfs(), 'db', { plugins });
    const src = source();
    await setFetch(db, src.fetch);
    const log: { session: string; msg: Response }[] = [];
    let handler: ((m: unknown) => unknown) | null = null;
    const server = new EngineServer(
      (session, msg) => {
        log.push({ session, msg });
        // The tab's client library: questions go to the handler set with onPluginMessage.
        if (session === 'tab-2' && msg.kind === 'pluginAsk') {
          void Promise.resolve()
            .then(() => (handler ? handler(msg.message) : Promise.reject(new Error('no handler'))))
            .then(
              (value) => server.receive('tab-2', { id: 0, op: 'pluginReply', target: msg.request, value } as Request),
              (e: Error) => server.receive('tab-2', { id: 0, op: 'pluginReply', target: msg.request, error: e.message } as Request),
            );
        }
      },
      { open: () => db, refreshTimer: false },
    );
    let id = 1;
    const call = async (session: string, body: Record<string, unknown>): Promise<Response> => {
      const rid = id++;
      server.receive(session, { ...body, id: rid } as Request);
      await until(`request ${rid}`, () => log.some((m) => m.msg.id === rid && ['ok', 'error', 'done'].includes(m.msg.kind)));
      return log.find((m) => m.msg.id === rid && ['ok', 'error', 'done'].includes(m.msg.kind))!.msg;
    };
    const calls: unknown[][] = [];
    const tab = {
      callPlugin: async (plugin: string, method: string, args: unknown[], options?: unknown) => {
        calls.push([plugin, method, args, options]);
        const r = await call('tab-2', { op: 'pluginCall', plugin, method, args });
        if (r.kind === 'error') throw Object.assign(new Error(r.message), { code: r.code });
        return (r as { value?: unknown }).value;
      },
      onPluginMessage: (_plugin: string, h: ((m: unknown) => unknown) | null) => void (handler = h),
    };
    await call(EngineServer.LOCAL, { op: 'open', name: 'db', storage: 'memory' });
    const urls: string[] = [];
    await registerCredentials(tab, 'tok', { endpoint: 'https://h/', headers: async (url) => (urls.push(url), { authorization: 'Bearer fresh' }) });
    expect(calls).toEqual([['@smaltdb/external', 'registerCredentials', ['tok', { endpoint: 'https://h/', callback: true }], { replay: 'cred:tok', dropReplay: false }]]);
    await call(EngineServer.LOCAL, { op: 'exec', sql: "CREATE CONNECTION c WITH (url = 'https://h', credentials = 'tok'); CREATE EXTERNAL TABLE e (a INT) WITH (connection = 'c', location = 'a.csv')" });
    expect(await call(EngineServer.LOCAL, { op: 'query', sql: 'SELECT sum(a) FROM e' })).toMatchObject({ kind: 'done' });
    expect(urls).toEqual(['https://h/a.csv']);
    expect(src.s.headers.at(-1)).toEqual({ authorization: 'Bearer fresh' });
    // Static credentials are sent as they are, and replace the callback.
    await registerCredentials(tab, 'tok', { endpoint: 'https://h/', headers: { authorization: 'Bearer static' } });
    expect(calls.at(-1)).toEqual(['@smaltdb/external', 'registerCredentials', ['tok', { endpoint: 'https://h/', headers: { authorization: 'Bearer static' } }], { replay: 'cred:tok', dropReplay: false }]);
    await call(EngineServer.LOCAL, { op: 'query', sql: 'SELECT sum(a) FROM e' });
    expect(src.s.headers.at(-1)).toEqual({ authorization: 'Bearer static' });
    expect(urls.length).toBe(1);
    await registerCredentials(tab, 'tok', null);
    expect(calls.at(-1)).toEqual(['@smaltdb/external', 'registerCredentials', ['tok', null], { replay: 'cred:tok', dropReplay: true }]);
    await registerFile(tab, 'f', null);
    expect(calls.at(-1)).toEqual(['@smaltdb/external', 'registerFile', ['f', null], { replay: 'file:f', dropReplay: true }]);
  });
});

describe('export over external data', () => {
  it('in-process and through the server', async () => {
    const db = await Database.open(new MemoryVfs(), 'db', { plugins });
    await registerFile(db, 'f', 'a,b\n1,2.5\n2,x\n');
    expect(await exportCSV(db, "SELECT * FROM read_csv('file:f', format => 'csv') ORDER BY a")).toBe('a,b\n1,2.5\n2,x\n');
    const log: Response[] = [];
    const server = new EngineServer((_s, msg) => log.push(msg), { open: () => db, refreshTimer: false });
    server.receive(EngineServer.LOCAL, { id: 1, op: 'open', name: 'db', storage: 'memory' } as Request);
    server.receive(EngineServer.LOCAL, { id: 2, op: 'pluginCall', plugin: '@smaltdb/io', method: 'exportJSON', args: ["SELECT a FROM read_csv('file:f', format => 'csv') ORDER BY a"] } as Request);
    await until('the export', () => log.some((m) => m.id === 2));
    expect(log.find((m) => m.id === 2)).toMatchObject({ kind: 'ok', value: '[{"a":1},{"a":2}]' });
  });
});
