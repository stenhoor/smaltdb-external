/**
 * M8.2 (ADR 0011): S3 and Azure Blob Storage sources, request signing, globs, Hive partitions and
 * partition pruning. Fake S3 and Azure servers verify every signature with their own (node:crypto)
 * implementation of the algorithms; SigV4 is also checked against AWS's published test vectors.
 */
import { createHash, createHmac } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database, MemoryVfs } from 'smaltdb/engine';
import { EngineServer } from 'smaltdb-src/engine/server.js';
import type { Request, Response } from 'smaltdb-src/shared/protocol.js';
import { until } from './helpers/wait.js';
import io from '@smaltdb/io';
import parquet from '@smaltdb/parquet';
import external from '../src/index.js';
import { type CredentialsProvider, registerCredentials, registerFile, setFetch } from '../src/client.js';
import { signV4 } from '../src/sign.js';

const plugins = [external, io];

const SALES_PARQUET = readFileSync('test/fixtures/parquet/sales-none.parquet');

const errorOf = async (p: Promise<unknown>): Promise<{ code: string; message: string }> => {
  try {
    await p;
  } catch (e) {
    return { code: (e as { code: string }).code, message: (e as Error).message };
  }
  throw new Error('expected an error');
};

describe('AWS Signature Version 4 (published test vectors)', () => {
  it('get-vanilla (aws-sig-v4-test-suite)', async () => {
    const h = await signV4({ method: 'GET', url: 'https://example.amazonaws.com/' }, { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }, 'us-east-1', 'service', new Date('2015-08-30T12:36:00Z'));
    expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  it('S3 GET Object example (S3 API reference)', async () => {
    const h = await signV4({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { Range: 'bytes=0-9' } }, { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }, 'us-east-1', 's3', new Date('2013-05-24T00:00:00Z'));
    expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
});

// ------------------------------------------------------------------ fake servers

const KEYS = { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret/key+TEST' };
const AZURE_KEY = Buffer.from('azure-account-key-for-tests').toString('base64');

interface Obj {
  body: string | Uint8Array;
  etag: string;
}

/** An object's body, or the byte range a `Range: bytes=s-e` header asks for (206, Content-Range). */
function sendObject(req: IncomingMessage, res: ServerResponse, body: string | Uint8Array, headers: Record<string, string>): void {
  const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  const m = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
  if (m) {
    const [s, e] = [Number(m[1]), Math.min(Number(m[2]), bytes.length - 1)];
    res.writeHead(206, { ...headers, 'content-range': `bytes ${s}-${e}/${bytes.length}` });
    res.end(req.method === 'HEAD' ? undefined : bytes.subarray(s, e + 1));
    return;
  }
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

/** Independent SigV4 check of an incoming request. */
function verifyV4(req: IncomingMessage, url: URL): boolean {
  const auth = String(req.headers.authorization ?? '');
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m || m[1] !== KEYS.accessKeyId) return false;
  const [, , day, region, signedHeaders, signature] = m;
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const query = [...url.searchParams]
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .sort()
    .join('&');
  const headers = signedHeaders
    .split(';')
    .map((h) => `${h}:${String(req.headers[h]).trim()}\n`)
    .join('');
  const creq = [req.method, url.pathname, query, headers, signedHeaders, req.headers['x-amz-content-sha256']].join('\n');
  const sts = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], `${day}/${region}/s3/aws4_request`, createHash('sha256').update(creq).digest('hex')].join('\n');
  let k: Buffer = createHmac('sha256', 'AWS4' + KEYS.secretAccessKey).update(day).digest();
  for (const part of [region, 's3', 'aws4_request']) k = createHmac('sha256', k).update(part).digest();
  return createHmac('sha256', k).update(sts).digest('hex') === signature;
}

/** Independent Azure Shared Key check. */
function verifySharedKey(req: IncomingMessage, url: URL, account: string): boolean {
  const auth = String(req.headers.authorization ?? '');
  if (!auth.startsWith(`SharedKey ${account}:`)) return false;
  const h = (n: string) => String(req.headers[n] ?? '');
  const ms = Object.keys(req.headers)
    .filter((n) => n.startsWith('x-ms-'))
    .sort()
    .map((n) => `${n}:${h(n).trim()}\n`)
    .join('');
  const params = [...new Set([...url.searchParams.keys()].map((k) => k.toLowerCase()))]
    .sort()
    .map((k) => `\n${k}:${url.searchParams.getAll(k).sort().join(',')}`)
    .join('');
  const sts = [req.method, '', '', '', '', '', '', '', '', '', '', h('range'), ms + `/${account}${url.pathname}` + params].join('\n');
  const sig = createHmac('sha256', Buffer.from(AZURE_KEY, 'base64')).update(sts, 'utf8').digest('base64');
  return auth === `SharedKey ${account}:${sig}`;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function startServer(handle: (req: IncomingMessage, res: ServerResponse, url: URL) => void) {
  const server = createServer((req, res) => handle(req, res, new URL(req.url!, 'http://x')));
  return {
    server,
    listen: () => new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`))),
  };
}

/** S3 (path-style): GET / HEAD objects, ListObjectsV2 with pagination (2 keys a page). */
function fakeS3(objects: Map<string, Obj>, log: string[]) {
  return startServer((req, res, url) => {
    const signed = verifyV4(req, url);
    const presigned = url.searchParams.get('X-Test-Presigned') === 'ok';
    log.push(`${req.method} ${url.pathname}${url.search}${req.headers.range ? ` [${req.headers.range}]` : ''}${signed ? ' signed' : presigned ? ' presigned' : ''}${req.headers['x-amz-security-token'] ? ' token' : ''}`);
    if (!signed && !presigned) {
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end('<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match</Message></Error>');
      return;
    }
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    if (url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}`)).map((k) => k.slice(bucket.length + 1)).sort();
      const start = Number(url.searchParams.get('continuation-token') ?? 0);
      const page = keys.slice(start, start + 2);
      const truncated = start + 2 < keys.length;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        `<?xml version="1.0"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>` +
          page.map((k) => `<Contents><Key>${xml(k)}</Key><ETag>&quot;${objects.get(`${bucket}/${k}`)!.etag}&quot;</ETag></Contents>`).join('') +
          (truncated ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : '') +
          '</ListBucketResult>',
      );
      return;
    }
    const o = objects.get(`${bucket}/${key}`);
    if (!o) {
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end('<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>');
      return;
    }
    sendObject(req, res, o.body, { etag: `"${o.etag}"` });
  });
}

/** Azure Blob (Azurite-style paths /account/container/blob): blobs, List Blobs, SAS / Shared Key / bearer. */
function fakeAzure(account: string, blobs: Map<string, Obj>, log: string[]) {
  return startServer((req, res, url) => {
    const auth = url.searchParams.get('sig') === 'testsig' ? 'sas' : verifySharedKey(req, url, account) ? 'sharedkey' : req.headers.authorization === 'Bearer entra-token' ? 'bearer' : null;
    log.push(`${req.method} ${url.pathname}${url.search.replace(/[?&]sig=testsig/, '')}${req.headers.range ? ` [${req.headers.range}]` : ''} ${auth}`);
    if (!auth || !req.headers['x-ms-version'] && auth !== 'sas') {
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end('<?xml version="1.0"?><Error><Code>AuthenticationFailed</Code><Message>Server failed to authenticate the request.</Message></Error>');
      return;
    }
    const [, acct, container, ...rest] = url.pathname.split('/');
    if (acct !== account) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (url.searchParams.get('comp') === 'list') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const names = [...blobs.keys()].filter((k) => k.startsWith(`${container}/${prefix}`)).map((k) => k.slice(container.length + 1)).sort();
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><EnumerationResults><Blobs>${names.map((n) => `<Blob><Name>${xml(n)}</Name><Properties><Etag>0x${blobs.get(`${container}/${n}`)!.etag}</Etag></Properties></Blob>`).join('')}</Blobs><NextMarker /></EnumerationResults>`);
      return;
    }
    const b = blobs.get(`${container}/${decodeURIComponent(rest.join('/'))}`);
    if (!b) {
      res.writeHead(404);
      res.end();
      return;
    }
    sendObject(req, res, b.body, { etag: `0x${b.etag}` });
  });
}

// ------------------------------------------------------------------ S3

describe('S3 sources', () => {
  const objects = new Map<string, Obj>();
  const log: string[] = [];
  const s3 = fakeS3(objects, log);
  let endpoint = '';
  beforeAll(async () => {
    endpoint = await s3.listen();
  });
  afterAll(() => s3.server.close());

  const put = (key: string, body: string) => objects.set(key, { body, etag: createHash('md5').update(body).digest('hex') });

  async function db() {
    const d = await Database.open(new MemoryVfs(), 'db', { plugins });
    await registerCredentials(d, 'aws', { endpoint: endpoint + '/', aws: KEYS });
    d.exec(`CREATE CONNECTION lake WITH (type = 's3', endpoint = '${endpoint}', region = 'eu-west-1', bucket = 'analytics', credentials = 'aws')`);
    return d;
  }

  beforeAll(() => {
    put('analytics/sales/year=2023/month=12/a.csv', 'id,amount\n1,10\n2,20\n');
    put('analytics/sales/year=2024/month=01/a.csv', 'id,amount\n3,30\n');
    put('analytics/sales/year=2024/month=02/b.csv', 'amount,id\n40,4\n'); // columns in another order
    put('analytics/sales/year=2024/month=02/notes.txt', 'not csv');
    put('analytics/one.json', '[{"k":"a b","v":1}]');
  });

  it('reads one object and a pattern of objects, with partition columns from the paths', async () => {
    const d = await db();
    expect((await d.queryAsync("SELECT * FROM read_json('s3://analytics/one.json', connection => 'lake')")).rows).toEqual([['a b', 1]]);
    await d.execAsync("CREATE EXTERNAL TABLE sales WITH (connection = 'lake', location = 'sales/year=*/month=*/*.csv')");
    expect(d.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'sales'").rows).toEqual([
      ['id', 'INTEGER'],
      ['amount', 'INTEGER'],
      ['year', 'INTEGER'],
      ['month', 'INTEGER'],
    ]);
    expect((await d.queryAsync('SELECT * FROM sales ORDER BY id')).rows).toEqual([
      [1, 10, 2023, 12],
      [2, 20, 2023, 12],
      [3, 30, 2024, 1],
      [4, 40, 2024, 2],
    ]);
    // Every request was signed; the listing followed its continuation tokens.
    expect(log.every((l) => l.endsWith(' signed'))).toBe(true);
    expect(log.some((l) => l.includes('continuation-token=2'))).toBe(true);
  });

  it('prunes partitions: files whose year / month fail the WHERE clause are not fetched', async () => {
    const d = await db();
    await d.execAsync("CREATE EXTERNAL TABLE sales WITH (connection = 'lake', location = 'sales/year=*/month=*/*.csv')");
    log.length = 0;
    expect((await d.queryAsync('SELECT id FROM sales WHERE year = 2024 AND month >= 2')).rows).toEqual([[4]]);
    // (Keys are sent percent-encoded per segment: `=` as %3D, as AWS SDKs do.)
    expect(log.filter((l) => l.startsWith('GET /analytics/sales/'))).toEqual(['GET /analytics/sales/year%3D2024/month%3D02/b.csv signed']);
    // Same answers as a local copy of all rows, for conditions it can and cannot decide.
    d.exec('CREATE TABLE copy(id INT, amount INT, year INT, month INT)');
    await d.execAsync('INSERT INTO copy SELECT * FROM sales');
    for (const where of ['year = 2023', 'year IN (2023, 2024) AND amount > 15', "CAST(month AS TEXT) = '1'", 'year + month > 2030', 'amount < 25', 'month IS NULL', "year = '2024'"]) {
      log.length = 0;
      const pruned = (await d.queryAsync(`SELECT id FROM sales WHERE ${where} ORDER BY id`)).rows;
      expect(pruned, where).toEqual(d.query(`SELECT id FROM copy WHERE ${where} ORDER BY id`).rows);
    }
    // A LEFT-joined external table is not pruned (its missing rows would become NULL rows).
    d.exec('CREATE TABLE k(id INT); INSERT INTO k VALUES (1), (4)');
    expect((await d.queryAsync('SELECT k.id, s.year FROM k LEFT JOIN sales s ON s.id = k.id WHERE s.year IS NULL OR s.year = 2024 ORDER BY 1')).rows).toEqual([[4, 2024]]);
  });

  it('IF CHANGED compares the listing (ETags), not the data', async () => {
    const d = await db();
    await d.execAsync("CREATE EXTERNAL TABLE sales WITH (connection = 'lake', location = 'sales/**/*.csv'); CREATE MATERIALIZED VIEW total AS SELECT sum(amount) AS s FROM sales");
    log.length = 0;
    await d.execAsync('REFRESH MATERIALIZED VIEW total IF CHANGED');
    expect(log.some((l) => l.startsWith('GET /analytics/sales/year'))).toBe(false); // listed only
    put('analytics/sales/year=2024/month=01/a.csv', 'id,amount\n3,300\n');
    await d.execAsync('REFRESH MATERIALIZED VIEW total IF CHANGED');
    expect(d.query('SELECT s FROM total').rows).toEqual([[370]]);
    put('analytics/sales/year=2024/month=01/a.csv', 'id,amount\n3,30\n');
  });

  it('Parquet by signed and presigned Range requests (the size from a range probe)', async () => {
    objects.set('analytics/sales.parquet', { body: SALES_PARQUET, etag: 'pq1' });
    for (const auth of [{ aws: KEYS }, { presign: (url: string) => `${url}?X-Test-Presigned=ok` }]) {
      const d = await Database.open(new MemoryVfs(), 'db', { plugins: [external, parquet] });
      await registerCredentials(d, 'aws', { endpoint: endpoint + '/', ...auth });
      d.exec(`CREATE CONNECTION lake WITH (type = 's3', endpoint = '${endpoint}', region = 'eu-west-1', bucket = 'analytics', credentials = 'aws')`);
      log.length = 0;
      expect((await d.queryAsync("SELECT sum(id) FROM read_parquet('sales.parquet', connection => 'lake')")).rows).toEqual([[(3999 * 4000) / 2]]);
      const kind = 'aws' in auth ? 'signed' : 'presigned';
      expect(log[0]).toMatch(new RegExp(`^GET /analytics/sales\\.parquet\\S* \\[bytes=0-0\\] ${kind}$`));
      expect(log.every((l) => l.startsWith('GET ') && / \[bytes=\d+-\d+\] /.test(l) && l.endsWith(` ${kind}`)), kind).toBe(true);
    }
  });

  it('session tokens, presigned URLs, refusals and errors', async () => {
    const d = await db();
    await registerCredentials(d, 'aws', { endpoint: endpoint + '/', aws: async () => ({ ...KEYS, sessionToken: 'sts-token' }) });
    log.length = 0;
    await d.queryAsync("SELECT * FROM read_json('one.json', connection => 'lake')");
    expect(log).toEqual(['GET /analytics/one.json signed token']);
    await registerCredentials(d, 'aws', { endpoint: endpoint + '/', presign: (url) => `${url}?X-Test-Presigned=ok` });
    log.length = 0;
    expect((await d.queryAsync("SELECT v FROM read_json('one.json', connection => 'lake')")).rows).toEqual([[1]]);
    expect(log).toEqual(['GET /analytics/one.json?X-Test-Presigned=ok presigned']);
    await registerCredentials(d, 'aws', { endpoint: endpoint + '/', aws: { ...KEYS, secretAccessKey: 'wrong' } });
    expect((await errorOf(d.queryAsync("SELECT * FROM read_json('one.json', connection => 'lake')"))).message).toBe(
      `read_json('one.json'): HTTP 403 Forbidden for ${endpoint}/analytics/one.json (SignatureDoesNotMatch: The request signature we calculated does not match)`,
    );
    await registerCredentials(d, 'aws', { endpoint: endpoint + '/', aws: KEYS });
    expect((await errorOf(d.queryAsync("SELECT * FROM read_csv('s3://analytics/nothing/*.csv', connection => 'lake')"))).message).toMatch(/no files match/);
    expect((await errorOf(d.queryAsync("SELECT * FROM read_csv('https://example.com/*.csv')"))).message).toMatch(/wildcards need a source that can be listed/);
    expect((await errorOf(d.queryAsync("SELECT * FROM read_csv('az://c/x.csv')"))).message).toMatch(/need an azure connection/);
  });

  it('AWS keys from a credentials callback across the worker boundary', async () => {
    const d = await Database.open(new MemoryVfs(), 'db', { plugins });
    const msgs: { session: string; msg: Response }[] = [];
    const server = new EngineServer((session, msg) => msgs.push({ session, msg }), { open: () => d, refreshTimer: false });
    let id = 1;
    const send = (body: Record<string, unknown>, session = EngineServer.LOCAL) => {
      const rid = id++;
      server.receive(session, { ...body, id: rid } as Request);
      return rid;
    };
    const ended = (rid: number) => msgs.some((m) => m.msg.id === rid && ['ok', 'error', 'done'].includes(m.msg.kind));
    for (const body of [
      { op: 'open', name: 'db', storage: 'memory' },
      { op: 'pluginCall', plugin: '@smaltdb/external', method: 'registerCredentials', args: ['aws', { endpoint: endpoint + '/', callback: true }] },
      { op: 'exec', sql: `CREATE CONNECTION lake WITH (type = 's3', endpoint = '${endpoint}', bucket = 'analytics', credentials = 'aws')` },
    ]) {
      const rid = send(body);
      await until(`request ${rid}`, () => ended(rid));
    }
    log.length = 0;
    const q = send({ op: 'query', sql: "SELECT v FROM read_json('one.json', connection => 'lake')" });
    await until('the question', () => msgs.some((m) => m.msg.kind === 'pluginAsk'));
    const ask = msgs.find((m) => m.msg.kind === 'pluginAsk')!.msg as Extract<Response, { kind: 'pluginAsk' }>;
    server.receive(EngineServer.LOCAL, { id: 0, op: 'pluginReply', target: ask.request, value: { aws: KEYS } } as Request);
    await until('the query', () => ended(q));
    expect(msgs.find((m) => m.msg.id === q && m.msg.kind === 'error')).toBeUndefined();
    expect(log).toEqual(['GET /analytics/one.json signed']);
  });

  it('virtual-hosted URLs on AWS', async () => {
    const d = await Database.open(new MemoryVfs(), 'db', { plugins });
    const urls: string[] = [];
    await setFetch(d, async (url) => {
      urls.push(url);
      return { ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('a\n1\n').buffer as ArrayBuffer };
    });
    d.exec("CREATE CONNECTION aws WITH (type = 's3', region = 'eu-west-1')");
    await d.queryAsync("SELECT * FROM read_csv('s3://my-bucket/dir/a b.csv', connection => 'aws')");
    expect(urls).toEqual(['https://my-bucket.s3.eu-west-1.amazonaws.com/dir/a%20b.csv']);
  });
});

// ------------------------------------------------------------------ Azure

describe('Azure Blob Storage sources', () => {
  const blobs = new Map<string, Obj>();
  const log: string[] = [];
  const az = fakeAzure('devstoreaccount1', blobs, log);
  let base = '';
  beforeAll(async () => {
    base = await az.listen();
    for (const [k, body] of [
      ['data/events/day=1/e.ndjson', '{"n":1}\n{"n":2}\n'],
      ['data/events/day=2/e.ndjson', '{"n":3}\n'],
    ] as const)
      blobs.set(k, { body, etag: createHash('md5').update(body).digest('hex') });
  });
  afterAll(() => az.server.close());

  async function db(auth: CredentialsProvider) {
    const d = await Database.open(new MemoryVfs(), 'db', { plugins });
    await registerCredentials(d, 'az', auth);
    d.exec(`CREATE CONNECTION store WITH (type = 'azure', account = 'devstoreaccount1', endpoint = '${base}/devstoreaccount1', container = 'data', credentials = 'az')`);
    return d;
  }

  it('Shared Key, SAS tokens and bearer tokens', async () => {
    for (const [azure, kind] of [
      [{ accountKey: AZURE_KEY }, 'sharedkey'],
      [{ sasToken: '?sv=2021-08-06&sig=testsig' }, 'sas'],
      [{ bearerToken: 'entra-token' }, 'bearer'],
    ] as const) {
      const d = await db({ endpoint: base + '/', azure });
      log.length = 0;
      expect((await d.queryAsync("SELECT day, sum(n) FROM read_json('events/day=*/*.ndjson', connection => 'store') GROUP BY day ORDER BY day")).rows, kind).toEqual([
        [1, 3],
        [2, 3],
      ]);
      expect(log.length).toBeGreaterThan(0);
      expect(log.every((l) => l.endsWith(` ${kind}`)), kind).toBe(true);
    }
  });

  it('Parquet by signed Range requests (the size from a range probe)', async () => {
    blobs.set('data/sales.parquet', { body: SALES_PARQUET, etag: 'pq1' });
    for (const [azure, kind] of [
      [{ accountKey: AZURE_KEY }, 'sharedkey'],
      [{ sasToken: '?sv=2021-08-06&sig=testsig' }, 'sas'],
      [{ bearerToken: 'entra-token' }, 'bearer'],
    ] as const) {
      const d = await Database.open(new MemoryVfs(), 'db', { plugins: [external, parquet] });
      await registerCredentials(d, 'az', { endpoint: base + '/', azure });
      d.exec(`CREATE CONNECTION store WITH (type = 'azure', account = 'devstoreaccount1', endpoint = '${base}/devstoreaccount1', container = 'data', credentials = 'az')`);
      log.length = 0;
      expect((await d.queryAsync("SELECT sum(id) FROM read_parquet('sales.parquet', connection => 'store')")).rows, kind).toEqual([[(3999 * 4000) / 2]]);
      expect(log[0], kind).toMatch(/^GET \/devstoreaccount1\/data\/sales\.parquet\S* \[bytes=0-0\] /);
      expect(log.every((l) => / \[bytes=\d+-\d+\] /.test(l) && l.endsWith(` ${kind}`)), kind).toBe(true);
    }
  });

  it('az:// locations, pruning, and authentication errors', async () => {
    const d = await db({ endpoint: base + '/', azure: { accountKey: AZURE_KEY } });
    await d.execAsync("CREATE EXTERNAL TABLE events WITH (connection = 'store', location = 'az://data/events/day=*/*.ndjson')");
    log.length = 0;
    expect((await d.queryAsync('SELECT n FROM events WHERE day = 2')).rows).toEqual([[3]]);
    expect(log.filter((l) => l.startsWith('GET /devstoreaccount1/data/events/day'))).toEqual(['GET /devstoreaccount1/data/events/day%3D2/e.ndjson sharedkey']);
    await registerCredentials(d, 'az', { endpoint: base + '/', azure: { accountKey: Buffer.from('wrong').toString('base64') } });
    expect((await errorOf(d.queryAsync('SELECT * FROM events'))).message).toMatch(/HTTP 403 .*\(AuthenticationFailed: Server failed to authenticate the request\.\)/);
  });
});

// ------------------------------------------------------------------ local patterns

describe('patterns over local files and registered files', () => {
  it('Node directories with ** and partitions; registered files by name pattern', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smaltdb-glob-'));
    for (const [p, body] of [
      ['region=eu/2024/a.csv', 'x\n1\n'],
      ['region=us/2024/b.csv', 'x\n2\n'],
      ['region=us/2025/c.csv', 'x\n3\n'],
      ['region=us/2025/skip.json', '[]'],
    ]) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), body);
    }
    const d = await Database.open(new MemoryVfs(), 'db', { plugins });
    expect((await d.queryAsync(`SELECT region, sum(x) FROM read_csv('${dir}/**/*.csv') GROUP BY region ORDER BY 1`)).rows).toEqual([
      ['eu', 1],
      ['us', 5],
    ]);
    expect((await d.queryAsync(`SELECT x FROM read_csv('${dir}/region=us/{2024,2025}/?.csv', hive_partitioning => false)`)).columns).toEqual(['x']);
    await registerFile(d, 'jan.csv', 'v\n1\n');
    await registerFile(d, 'feb.csv', 'v\n2\n');
    await registerFile(d, 'notes.txt', 'nope');
    expect((await d.queryAsync("SELECT sum(v) FROM read_csv('file:*.csv')")).rows).toEqual([[3]]);
  });
});
