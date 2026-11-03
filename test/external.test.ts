/**
 * External tables and reading table functions (M8.1, ADR 0011): sources (registered files, Node
 * paths, HTTP), CSV / JSON readers, the catalog, the async API and its rules.
 */
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database, type SmaltPlugin, MemoryVfs } from 'smaltdb/engine';
import { EngineServer } from 'smaltdb-src/engine/server.js';
import io from '@smaltdb/io';
import external from '../src/index.js';
import { type FetchFn, registerCredentials, registerFile, setFetch } from '../src/client.js';
import { type Request, type Response, columnValue } from 'smaltdb-src/shared/protocol.js';
import { until } from './helpers/wait.js';

const errorOf = async (p: Promise<unknown> | (() => unknown)): Promise<{ code: string; message: string }> => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return { code: (e as { code: string }).code, message: (e as Error).message };
  }
  throw new Error('expected an error');
};

/** A fetch that serves `files` (url -> body) and records requests. */
function fakeFetch(files: Record<string, string>, log: { url: string; headers: Record<string, string> }[] = []): FetchFn {
  return async (url, init) => {
    log.push({ url, headers: init.headers });
    const body = files[url];
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      statusText: body === undefined ? 'Not Found' : 'OK',
      headers: { get: (h: string) => (h === 'etag' ? '"v1"' : null) },
      arrayBuffer: async () => new TextEncoder().encode(body ?? '').buffer as ArrayBuffer,
    };
  };
}

const plugins = [external, io];

async function memDb(): Promise<Database> {
  return Database.open(new MemoryVfs(), 'db', { plugins });
}

describe('CSV reader', () => {
  it('infers columns and types, keeps quoted text, empty fields are NULL', async () => {
    const db = await memDb();
    await registerFile(db, 'p', 'id,name,price,code\n1,apple,1.5,007\n2,"pear, ""green""",2,010\n3,,,\n');
    const r = await db.queryAsync("SELECT * FROM read_csv('file:p')");
    expect(r.columns).toEqual(['id', 'name', 'price', 'code']);
    expect(r.rows).toEqual([
      [1, 'apple', 1.5, 7],
      [2, 'pear, "green"', 2, 10],
      [3, null, null, null],
    ]);
    expect((await db.queryAsync("SELECT typeof(price), typeof(name) FROM read_csv('file:p') WHERE id = 2")).rows).toEqual([['real', 'text']]);
  });

  it('honors header, delimiter, quote, null, skip and tsv', async () => {
    const db = await memDb();
    await registerFile(db, 'semi', "# exported 2026\n'a;b';2;NA\nc;3;x\n");
    expect((await db.queryAsync("SELECT * FROM read_csv('file:semi', header => false, delimiter => ';', quote => '''', null => 'NA', skip => 1)")).rows).toEqual([
      ['a;b', 2, null],
      ['c', 3, 'x'],
    ]);
    await registerFile(db, 't.tsv', 'k\tv\nx\t1\n');
    expect(await db.queryAsync("SELECT * FROM read_csv('file:t.tsv')")).toEqual({ columns: ['k', 'v'], rows: [['x', 1]] });
    await registerFile(db, 'dup', 'a,a,\n1,2,3\n');
    expect((await db.queryAsync("SELECT * FROM read_csv('file:dup')")).columns).toEqual(['a', 'a_2', 'column3']);
  });

  it('reports malformed input with the source and line', async () => {
    const db = await memDb();
    await registerFile(db, 'bad', 'a,b\n1,2\n3\n');
    expect(await errorOf(db.queryAsync("SELECT * FROM read_csv('file:bad')"))).toEqual({ code: 'SMALT_EXTERNAL', message: "read_csv('file:bad'): CSV line 3: expected 2 fields but found 1" });
    expect((await errorOf(db.queryAsync("SELECT * FROM read_csv('file:bad', delim => ';')"))).message).toMatch(/unknown option 'delim'/);
    expect((await errorOf(db.queryAsync("SELECT * FROM read_csv('file:nope')"))).message).toMatch(/no file is registered as 'nope'/);
  });
});

describe('JSON reader', () => {
  it('reads arrays of objects and NDJSON, typing columns', async () => {
    const db = await memDb();
    await registerFile(db, 'a.json', '[{"id":1,"tags":["x"],"ok":true},{"id":2.5,"name":"b","ok":false}]');
    expect(await db.queryAsync("SELECT * FROM read_json('file:a.json')")).toEqual({
      columns: ['id', 'tags', 'ok', 'name'],
      rows: [
        [1, '["x"]', 1, null],
        [2.5, null, 0, 'b'],
      ],
    });
    await registerFile(db, 'b', '{"k":"a","v":1}\n\n{"k":"b","v":2}\n');
    expect((await db.queryAsync("SELECT sum(v) FROM read_json('file:b', format => 'ndjson')")).rows).toEqual([[3]]);
    await registerFile(db, 'bad.json', '[1, {"a": 2}]');
    expect((await errorOf(db.queryAsync("SELECT * FROM read_json('file:bad.json')"))).message).toMatch(/objects or arrays/);
  });
});

describe('external tables', () => {
  it('declared or inferred columns, persisted with the catalog, never with secrets', async () => {
    const vfs = new MemoryVfs();
    const db = await Database.open(vfs, 'db', { plugins });
    const log: { url: string; headers: Record<string, string> }[] = [];
    await setFetch(db, fakeFetch({ 'https://api.example.com/v1/kv.csv': 'k,v\n1,10\n2,20\n' }, log));
    await registerCredentials(db, 'tok', { endpoint: 'https://api.example.com/', headers: { authorization: 'Bearer s3cret' } });
    await registerFile(db, 'p', 'id;label\n1;one\n2;two\n');
    await db.execAsync("CREATE CONNECTION api WITH (url = 'https://api.example.com/v1', credentials = 'tok')");
    await db.execAsync("CREATE EXTERNAL TABLE kv WITH (connection = 'api', location = 'kv.csv')");
    await db.execAsync("CREATE EXTERNAL TABLE labels (id INTEGER, label TEXT) WITH (location = 'file:p', format = 'csv', delimiter = ';')");
    expect(log).toEqual([{ url: 'https://api.example.com/v1/kv.csv', headers: { authorization: 'Bearer s3cret' } }]);
    expect((await db.queryAsync('SELECT l.label, kv.v FROM kv JOIN labels l ON l.id = kv.k ORDER BY 1')).rows).toEqual([
      ['one', 10],
      ['two', 20],
    ]);
    expect(db.query("SELECT table_name, table_type FROM information_schema.tables WHERE table_type = 'EXTERNAL' ORDER BY 1").rows).toEqual([
      ['kv', 'EXTERNAL'],
      ['labels', 'EXTERNAL'],
    ]);
    expect(db.query("SELECT table_name, location, format, connection_name, options FROM information_schema.external_tables ORDER BY 1").rows).toEqual([
      ['kv', 'kv.csv', 'csv', 'api', '{}'],
      ['labels', 'file:p', 'csv', null, '{"delimiter":";"}'],
    ]);
    expect(db.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'kv'").rows).toEqual([
      ['k', 'INTEGER'],
      ['v', 'INTEGER'],
    ]);
    expect(db.query('SELECT * FROM information_schema.connections').rows).toEqual([['api', 'http', 'https://api.example.com/v1', 'tok', '{}']]);
    db.close();
    const again = await Database.open(vfs, 'db', { plugins });
    const stored = again.query("SELECT group_concat(sql, ' | ') FROM smalt_schema WHERE type IN ('external', 'connection')").rows[0][0] as string;
    expect(stored).toContain('CREATE EXTERNAL TABLE "kv" ("k" INTEGER, "v" INTEGER)');
    expect(stored).not.toContain('s3cret');
    // Credentials are runtime state: after reopening they must be registered again.
    await setFetch(again, fakeFetch({ 'https://api.example.com/v1/kv.csv': 'k,v\n1,10\n' }));
    expect((await errorOf(again.queryAsync('SELECT * FROM kv'))).message).toMatch(/no credentials are registered as 'tok'/);
    await registerCredentials(again, 'tok', { endpoint: 'https://api.example.com/', headers: {} });
    expect((await again.queryAsync('SELECT * FROM kv')).rows).toEqual([[1, 10]]);
  });

  it('sends credentials only to their endpoint', async () => {
    const db = await memDb();
    const log: { url: string; headers: Record<string, string> }[] = [];
    await setFetch(db, fakeFetch({ 'https://evil.example.net/x.csv': 'a\n1\n' }, log));
    await registerCredentials(db, 'tok', { endpoint: 'https://api.example.com/', headers: { authorization: 'Bearer s3cret' } });
    db.exec("CREATE CONNECTION c WITH (url = 'https://evil.example.net', credentials = 'tok')");
    await db.execAsync("CREATE EXTERNAL TABLE x (a INT) WITH (connection = 'c', location = 'x.csv')");
    expect((await errorOf(db.queryAsync('SELECT * FROM x'))).message).toBe("x: credentials 'tok' are bound to https://api.example.com/; refusing to send them to https://evil.example.net/x.csv");
    expect(log).toEqual([]);
  });

  it('rules: names, options, DROP', async () => {
    const db = await memDb();
    await registerFile(db, 'f', 'a\n1\n');
    expect((await errorOf(() => db.exec("CREATE EXTERNAL TABLE e (a INT) WITH (location = 'file:f', colour = 'red')"))).message).toMatch(/unknown option 'colour'/);
    expect((await errorOf(() => db.exec("CREATE EXTERNAL TABLE e (a INT) WITH (location = 'file:f.xlsx')"))).message).toMatch(/cannot tell the format/);
    expect((await errorOf(() => db.exec("CREATE EXTERNAL TABLE e (a INT PRIMARY KEY) WITH (location = 'file:f', format = 'csv')"))).message).toMatch(/cannot have constraints/);
    expect((await errorOf(() => db.exec("CREATE EXTERNAL TABLE e (a INT) WITH (location = 'file:f', format = 'csv', connection = 'none')"))).message).toMatch(/no such connection: none/);
    expect((await errorOf(() => db.exec("CREATE CONNECTION c WITH (type = 'gcs')"))).message).toMatch(/type 'gcs' is not supported \(http, s3, azure\)/);
    expect((await errorOf(() => db.exec("CREATE CONNECTION c WITH (type = 's3', url = 'https://x')"))).message).toMatch(/unknown option 'url' for type s3/);
    expect((await errorOf(() => db.exec("CREATE CONNECTION c WITH (type = 'azure', container = 'x')"))).message).toMatch(/needs account/);
    db.exec("CREATE CONNECTION c WITH (url = 'https://example.com'); CREATE EXTERNAL TABLE e (a INT) WITH (location = 'f.csv', connection = 'c')");
    expect((await errorOf(() => db.exec('CREATE TABLE e(x)'))).message).toBe('external table e already exists');
    expect((await errorOf(() => db.exec('DROP TABLE e'))).message).toBe('use DROP EXTERNAL TABLE to delete external table e');
    expect((await errorOf(() => db.exec('DROP CONNECTION c'))).message).toBe('connection c is used by external table e');
    db.exec('CREATE TABLE c(x)'); // connections have their own namespace
    db.exec('DROP EXTERNAL TABLE e; DROP CONNECTION c; DROP EXTERNAL TABLE IF EXISTS e; DROP CONNECTION IF EXISTS c');
    expect(db.query("SELECT count(*) FROM smalt_schema WHERE type IN ('external', 'connection')").rows).toEqual([[0]]);
  });

  it('a rolled-back CREATE leaves nothing behind', async () => {
    const db = await memDb();
    await registerFile(db, 'f', 'a\n1\n');
    db.exec('BEGIN');
    // Inferring the columns needs the data: through the synchronous API it fails, and is undone.
    expect((await errorOf(() => db.exec("CREATE EXTERNAL TABLE e WITH (location = 'file:f', format = 'csv')"))).code).toBe('SMALT_ASYNC_REQUIRED');
    expect(db.query('SELECT count(*) FROM information_schema.external_tables').rows).toEqual([[0]]);
    db.exec('ROLLBACK');
  });
});

describe('the async API', () => {
  it('the synchronous API refuses statements over external data', async () => {
    const db = await memDb();
    await registerFile(db, 'f', 'a\n1\n');
    await db.execAsync("CREATE EXTERNAL TABLE e (a INT) WITH (location = 'file:f', format = 'csv')");
    db.exec('CREATE TABLE t(a INT)');
    for (const sql of ['SELECT * FROM e', "SELECT * FROM read_csv('file:f')", 'INSERT INTO t SELECT * FROM e']) {
      expect(await errorOf(() => db.query(sql))).toEqual({ code: 'SMALT_ASYNC_REQUIRED', message: expect.stringMatching(/run it with queryAsync \/ execAsync/) });
    }
    expect(db.query('SELECT count(*) FROM t').rows).toEqual([[0]]);
    // Statements over local data run as before, also through the async API.
    expect((await db.queryAsync('SELECT 1 + 1')).rows).toEqual([[2]]);
    expect(db.query('EXPLAIN QUERY PLAN SELECT * FROM e WHERE a > 0').rows).toEqual([[1, 0, 0, 'SCAN EXTERNAL e (file:f)']]);
  });

  it('views, materialized views and INSERT … SELECT over external data', async () => {
    const db = await memDb();
    await registerFile(db, 'f', 'g,x\n1,10\n1,20\n2,5\n');
    await db.execAsync("CREATE VIEW v AS SELECT g, sum(x) AS s FROM read_csv('file:f') GROUP BY g");
    expect((await db.queryAsync('SELECT * FROM v ORDER BY g')).rows).toEqual([
      [1, 30],
      [2, 5],
    ]);
    await db.execAsync("CREATE EXTERNAL TABLE e (g INT, x INT) WITH (location = 'file:f', format = 'csv')");
    await db.execAsync('CREATE MATERIALIZED VIEW m AS SELECT g, sum(x) AS s FROM e GROUP BY g');
    expect(db.query('SELECT * FROM m ORDER BY g').rows).toEqual([
      [1, 30],
      [2, 5],
    ]);
    // A cache of external data is never used to answer queries implicitly (the source may change).
    db.exec('PRAGMA matview_rewrite = 1');
    expect((await errorOf(() => db.query('SELECT g, sum(x) FROM e GROUP BY g'))).code).toBe('SMALT_ASYNC_REQUIRED');
    await registerFile(db, 'f', 'g,x\n1,1\n');
    await db.execAsync('REFRESH MATERIALIZED VIEW m');
    expect(db.query('SELECT * FROM m').rows).toEqual([[1, 1]]);
    db.exec('CREATE TABLE t(g INT, x INT)');
    expect((await db.runAsync('INSERT INTO t SELECT * FROM e')).changes).toBe(1);
  });

  it('fetches each source once per statement, concurrently, shared between concurrent calls', async () => {
    const db = await memDb();
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: string[] = [];
    await setFetch(db, async (url) => {
      calls.push(url);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('a\n1\n2\n').buffer as ArrayBuffer };
    });
    const sql = "SELECT count(*) FROM read_csv('https://h/a.csv') x JOIN read_csv('https://h/a.csv') y ON x.a = y.a JOIN read_csv('https://h/b.csv') z ON z.a = x.a";
    expect((await db.queryAsync(sql)).rows).toEqual([[2]]);
    expect(calls.sort()).toEqual(['https://h/a.csv', 'https://h/b.csv']);
    expect(maxInFlight).toBe(2);
    calls.length = 0;
    const [r1, r2] = await Promise.all([db.queryAsync(sql), db.queryAsync(sql)]);
    expect([r1.rows, r2.rows]).toEqual([[[2]], [[2]]]);
    expect(calls.length).toBe(2); // the second call shares the first one's fetches
  });

  it('an abort stops the fetch', async () => {
    const db = await memDb();
    await setFetch(db, (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    const ac = new AbortController();
    const p = db.queryAsync("SELECT * FROM read_csv('https://h/slow.csv')", undefined, { signal: ac.signal });
    ac.abort();
    expect((await errorOf(p)).code).toBe('SMALT_INTERRUPT');
  });
});

describe('sources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smaltdb-ext-'));
  let server: ReturnType<typeof createServer>;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/data.csv') {
        res.writeHead(200, { 'content-type': 'text/csv', etag: '"abc"' });
        res.end('n\n1\n2\n3\n');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  it('reads http(s) URLs with the real fetch, and reports HTTP errors', async () => {
    const db = await memDb();
    expect((await db.queryAsync(`SELECT sum(n) FROM read_csv('${base}/data.csv')`)).rows).toEqual([[6]]);
    expect(await errorOf(db.queryAsync(`SELECT * FROM read_csv('${base}/missing.csv')`))).toEqual({ code: 'SMALT_EXTERNAL', message: `read_csv('${base}/missing.csv'): HTTP 404 Not Found for ${base}/missing.csv` });
  });

  it('reads Node paths, bytes and blobs', async () => {
    const db = await memDb();
    const path = join(dir, 'x.json');
    writeFileSync(path, '[{"a":1},{"a":2}]');
    expect((await db.queryAsync(`SELECT sum(a) FROM read_json('${path}')`)).rows).toEqual([[3]]);
    await registerFile(db, 'bytes', new TextEncoder().encode('a\n5\n'));
    await registerFile(db, 'blob', new Blob(['a\n7\n']));
    expect((await db.queryAsync("SELECT (SELECT a FROM read_csv('file:bytes')) + (SELECT a FROM read_csv('file:blob'))")).rows).toEqual([[12]]);
  });

  it('random access says when a failed read would fail again with the whole file (no retry)', async () => {
    // A random-access format whose error asks for a whole-file retry (wholeFileMayHelp), counting reads.
    let reads = 0;
    const tail: SmaltPlugin = {
      name: 'tail-format',
      version: '1.0.0',
      apiVersion: 1,
      setup(host) {
        host.addFormat({
          name: 'tail',
          extensions: ['tail'],
          access: 'random',
          async read(file) {
            reads++;
            const last = new Uint8Array(await file.slice(file.byteLength - 1, file.byteLength))[0];
            if (last !== 0x23) throw Object.assign(new Error('no # at the end'), { wholeFileMayHelp: true });
            return { columns: [{ name: 'n', declType: 'INTEGER' }], rows: [[file.byteLength]] };
          },
        });
        host.addTableFunction('read_tail', { format: 'tail' });
      },
    };
    const db = await Database.open(new MemoryVfs(), 'db', { plugins: [external, tail] });
    const path = join(dir, 'x.tail');
    writeFileSync(path, 'abc');
    await registerFile(db, 'a.tail', 'abc');
    await registerFile(db, 'b.tail', new Blob(['abc']));
    // Registered files and Node paths have an exact size: one read, the error at once.
    for (const loc of ['file:a.tail', 'file:b.tail', path]) {
      reads = 0;
      expect(await errorOf(db.queryAsync(`SELECT * FROM read_tail('${loc}')`)), loc).toMatchObject({ code: 'SMALT_EXTERNAL', message: expect.stringMatching(/no # at the end$/) });
      expect(reads, loc).toBe(1);
    }
    // HTTP: a probe whose total is wrong (here one byte short) is retried once with the whole file;
    // a server that ignored the range sent the whole file already, so its error is final.
    const body = new TextEncoder().encode('abc#');
    const requests: string[] = [];
    await setFetch(db, async (url, init) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(init.headers.range ?? '');
      requests.push(`${url} ${init.headers.range ?? 'whole'}`);
      // later.tail: a 206 for the probe, then 200s with the whole body (the server ignores later ranges).
      const ranged = range && (url.endsWith('/short.tail') || (url.endsWith('/later.tail') && init.headers.range === 'bytes=0-0'));
      const [s, e] = ranged ? [Number(range[1]), Math.min(Number(range[2]), 2)] : [0, body.length - 1];
      const sent = url.endsWith('/bad.tail') || url.endsWith('/later.tail') ? new TextEncoder().encode('abc').slice(s, e + 1) : body.slice(s, e + 1);
      return {
        ok: true,
        status: ranged ? 206 : 200,
        statusText: '',
        headers: { get: (h: string) => (h === 'content-range' && ranged ? `bytes ${s}-${e}/3` : null) },
        arrayBuffer: async () => sent.buffer as ArrayBuffer,
      };
    });
    reads = 0;
    expect((await db.queryAsync("SELECT n FROM read_tail('https://example.test/short.tail')")).rows).toEqual([[4]]);
    expect(reads).toBe(2);
    expect(requests).toEqual(['https://example.test/short.tail bytes=0-0', 'https://example.test/short.tail bytes=2-2', 'https://example.test/short.tail whole']);
    reads = 0;
    requests.length = 0;
    expect(await errorOf(db.queryAsync("SELECT n FROM read_tail('https://example.test/bad.tail')"))).toMatchObject({ code: 'SMALT_EXTERNAL' });
    expect([reads, requests]).toEqual([1, ['https://example.test/bad.tail bytes=0-0']]);
    // A later range answered with 200: that body is kept for the other slices and is the whole file.
    reads = 0;
    requests.length = 0;
    expect(await errorOf(db.queryAsync("SELECT n FROM read_tail('https://example.test/later.tail')"))).toMatchObject({ code: 'SMALT_EXTERNAL' });
    expect([reads, requests]).toEqual([1, ['https://example.test/later.tail bytes=0-0', 'https://example.test/later.tail bytes=2-2']]);
  });
});

describe('patterns and URLs', () => {
  it('wildcards only in a URL path; an http connection without url lists local paths; option lists', async () => {
    const db = await memDb();
    const urls: string[] = [];
    await setFetch(db, async (url) => {
      urls.push(url);
      return { ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('a\n1\n').buffer as ArrayBuffer };
    });
    expect(await errorOf(db.queryAsync("SELECT * FROM read_csv('https://example.com/*.csv')"))).toEqual({
      code: 'SMALT_EXTERNAL',
      message: "read_csv('https://example.com/*.csv'): wildcards need a source that can be listed (S3, Azure, local paths or registered files), not an HTTP URL",
    });
    db.exec("CREATE CONNECTION api WITH (url = 'https://h/v1')");
    expect((await db.queryAsync("SELECT a FROM read_csv('a.csv?v=1', connection => 'api', format => 'csv')")).rows).toEqual([[1]]);
    expect(urls).toEqual(['https://h/v1/a.csv?v=1']);
    const dir = mkdtempSync(join(tmpdir(), 'smaltdb-noconn-'));
    writeFileSync(join(dir, 'x.csv'), 'n\n4\n');
    writeFileSync(join(dir, 'y.csv'), 'n\n5\n');
    db.exec("CREATE CONNECTION local WITH (type = 'http')");
    expect((await db.queryAsync(`SELECT sum(n) FROM read_csv('${dir}/*.csv', connection => 'local')`)).rows).toEqual([[9]]);
    expect((await errorOf(() => db.exec("CREATE CONNECTION c WITH (type = 's3', url = 'https://x')"))).message).toBe(
      "connection c: unknown option 'url' for type s3 (type, region, bucket, endpoint, url_style, credentials)",
    );
  });
});

describe('through the engine server (worker protocol)', () => {
  async function setup() {
    const db = await memDb();
    const log: Response[] = [];
    const server = new EngineServer((_s, msg) => log.push(msg), { open: () => db });
    let id = 1;
    const send = (body: Record<string, unknown>): number => {
      const rid = id++;
      server.receive(EngineServer.LOCAL, { ...body, id: rid } as Request);
      return rid;
    };
    const ended = (rid: number) => log.some((m) => m.id === rid && (m.kind === 'done' || m.kind === 'error' || m.kind === 'ok'));
    const result = async (rid: number) => {
      await until(`request ${rid}`, () => ended(rid));
      const err = log.find((m) => m.id === rid && m.kind === 'error');
      if (err) return err;
      const rows: unknown[][] = [];
      for (const m of log) if (m.id === rid && m.kind === 'batch') for (let i = 0; i < m.length; i++) rows.push(m.cols.map((c) => columnValue(c, i)));
      return rows;
    };
    await result(send({ op: 'open', name: 'db', storage: 'memory' }));
    return { db, send, result };
  }

  it('registers files, creates external tables and queries them', async () => {
    const t = await setup();
    await t.result(t.send({ op: 'pluginCall', plugin: '@smaltdb/external', method: 'registerFile', args: ['f', 'a,b\n1,x\n2,y\n'] }));
    await t.result(t.send({ op: 'exec', sql: "CREATE EXTERNAL TABLE e WITH (location = 'file:f', format = 'csv'); CREATE TABLE t(a INT, b TEXT); INSERT INTO t SELECT * FROM e" }));
    expect(await t.result(t.send({ op: 'query', sql: 'SELECT e.b, t.a FROM e JOIN t USING (a) ORDER BY 1' }))).toEqual([
      ['x', 1],
      ['y', 2],
    ]);
    expect(await t.result(t.send({ op: 'exec', sql: 'INSERT INTO t SELECT a + 10, b FROM e WHERE a = ?', params: [1] }))).toEqual([]);
    expect(await t.result(t.send({ op: 'query', sql: 'SELECT count(*) FROM t' }))).toEqual([[3]]);
    const prep = t.send({ op: 'prepare', sql: "SELECT b FROM read_csv('file:f') WHERE a = ?" });
    await t.result(prep);
    expect(await t.result(t.send({ op: 'stmtQuery', stmt: 1, params: [2] }))).toEqual([['y']]);
  });

  it('a cancel stops a request waiting on its fetch', async () => {
    const t = await setup();
    await setFetch(t.db, (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    const q = t.send({ op: 'query', sql: "SELECT * FROM read_csv('https://h/slow.csv')" });
    await until('the fetch to start', () => true);
    t.send({ op: 'cancel', target: q });
    expect(await t.result(q)).toMatchObject({ kind: 'error', code: 'SMALT_INTERRUPT' });
    // The server goes on serving.
    expect(await t.result(t.send({ op: 'query', sql: 'SELECT 42' }))).toEqual([[42]]);
  });
});
