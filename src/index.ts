/**
 * @smaltdb/external: where smaltdb's external tables and `read_*` functions read from (ADR 0012).
 *
 * Sources:
 * - `file:<name>`: files the application registers (`registerFile`), listed by name for patterns;
 * - `http(s)://` URLs, and locations relative to an http connection's `url`;
 * - `s3://bucket/key`, and keys relative to an s3 connection's bucket (SigV4 signing, ListObjectsV2);
 * - `az://container/blob`, and blobs relative to an azure connection's container (SAS, Shared Key or
 *   bearer tokens, List Blobs);
 * - plain paths: the Node file system (in a browser: register the file and use `file:<name>`).
 *
 * Connection types `http` (alias `https`), `s3` and `azure`; methods `registerFile`,
 * `registerCredentials` and `setFetch` (helpers in `@smaltdb/external/client`).
 */
import type { AskError, ListedFile, OpenedFile, PluginHost, RandomAccessFile, SmaltPlugin, SourceContext, SourceHandler, SourceTarget, SqlValue } from 'smaltdb/engine';
import { AZURE_VERSION, signAzureSharedKey, signV4 } from './sign.js';
import { type CallbackCredentials, type CredentialMaterial, type CredentialsProvider, type CredentialsQuestion, type FetchFn, type FileSource, materialOf } from './types.js';

export type { AwsKeys, AzureAuth, CallbackCredentials, CredentialMaterial, CredentialsProvider, FetchFn, FileSource } from './types.js';
export { signAzureSharedKey, signV4 } from './sign.js';

declare const __PLUGIN_VERSION__: string | undefined;
const VERSION = typeof __PLUGIN_VERSION__ === 'string' ? __PLUGIN_VERSION__ : '0.0.0';
const NAME = '@smaltdb/external';
/** How long the engine waits for a tab's credentials callback. */
const ASK_TIMEOUT_MS = 30_000;

const external: SmaltPlugin = {
  name: NAME,
  version: VERSION,
  apiVersion: 1,
  setup(host) {
    const state = new Sources(host);
    const httpUrl = (k: string) => (o: Record<string, SqlValue>) => {
      const v = o[k];
      if (v !== undefined && v !== null && !/^https?:\/\//i.test(String(v))) throw new Error(`${k} must be an http(s) URL`);
    };
    host.addConnectionType('http', { options: ['url'], aliases: ['https'], validate: httpUrl('url') });
    host.addConnectionType('s3', {
      options: ['region', 'bucket', 'endpoint', 'url_style'],
      validate(o) {
        httpUrl('endpoint')(o);
        const style = o.url_style;
        if (style !== undefined && style !== null && !['path', 'virtual'].includes(String(style).toLowerCase())) throw new Error("url_style must be 'path' or 'virtual'");
      },
    });
    host.addConnectionType('azure', {
      options: ['account', 'container', 'endpoint'],
      validate(o) {
        httpUrl('endpoint')(o);
        if (!o.account) throw new Error('an azure connection needs account (the storage account name)');
      },
    });
    // Every source resolves a location the same way (placeOf); they differ in what core routes to them.
    // (An http connection without `url` reads local paths, so the http source lists too.)
    const source = (name: string, spec: Pick<SourceHandler, 'prefixes' | 'connectionTypes' | 'paths'>): SourceHandler => ({
      name,
      ...spec,
      open: (t, ctx) => state.open(t, ctx),
      validator: (t, ctx) => state.validator(t, ctx),
      isPattern: (t) => state.isPattern(t),
      list: (t, ctx) => state.list(t, ctx),
    });
    host.addSource(source('file', { prefixes: ['file:'] }));
    host.addSource(source('http', { prefixes: ['http:', 'https:'], connectionTypes: ['http', 'https'] }));
    host.addSource(source('s3', { prefixes: ['s3://'], connectionTypes: ['s3'] }));
    host.addSource(source('azure', { prefixes: ['az://', 'azure://'], connectionTypes: ['azure'] }));
    host.addSource(source('path', { prefixes: [], paths: true }));

    host.addMethod('registerFile', (_ctx, [name, file]) => {
      if (file === null || file === undefined) state.files.delete(String(name));
      else state.files.set(String(name), file as FileSource);
    });
    host.addMethod('registerCredentials', (ctx, [name, provider]) => {
      const n = String(name);
      if (provider === null || provider === undefined) state.credentials.delete(n);
      else if ((provider as CallbackCredentials).callback) state.credentials.set(n, { provider: provider as CallbackCredentials, session: ctx.session });
      else state.credentials.set(n, { provider: provider as CredentialsProvider });
    });
    host.addMethod('setFetch', (_ctx, [fn]) => {
      state.fetchFn = typeof fn === 'function' ? (fn as FetchFn) : null;
    });
    // Callback credentials go with the session (tab) that answers for them.
    host.onSessionClosed((session) => {
      for (const [name, c] of state.credentials) if (c.session === session) state.credentials.delete(name);
    });
  },
};
export default external;

// ------------------------------------------------------------------ places

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const isNode = (): boolean => typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node;

/** Percent-encode a key's path segments (S3 keys and blob names), keeping `/`. */
const encodeKey = (key: string): string =>
  key
    .split('/')
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');

/** Where a location lives: the backend and what it needs to reach it. */
type Place =
  | { kind: 'http'; url: string }
  | { kind: 'file'; name: string }
  | { kind: 'node'; path: string }
  | { kind: 's3'; bucket: string; key: string; region: string; endpoint: string | null; pathStyle: boolean }
  | { kind: 'azure'; account: string; container: string; key: string; base: string };

type Connection = NonNullable<SourceTarget['connection']>;

const opt = (o: Record<string, SqlValue> | undefined, k: string): string | null => {
  const v = o?.[k];
  return v === undefined || v === null ? null : String(v);
};

/** XML text with entities decoded (S3 and Azure listings). */
const xmlText = (s: string): string =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_m, e: string) =>
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'" : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)),
  );
const xmlTag = (xml: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? xmlText(m[1]) : null;
};
const xmlAll = (xml: string, tag: string): string[] => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);

/** Where `location` lives (relative locations resolve against the connection). */
function placeOf(target: SourceTarget, location = target.location): Place {
  const conn = target.connection;
  const type = conn ? String(conn.options.type ?? 'http').toLowerCase() : null;
  const o = conn?.options;
  if (/^file:/i.test(location)) return { kind: 'file', name: location.slice(5) };
  if (/^https?:/i.test(location)) return { kind: 'http', url: location };
  const s3 = /^s3:\/\/([^/]+)\/?(.*)$/i.exec(location);
  if (s3) return s3Place(conn, s3[1], s3[2]);
  const az = /^(?:az|azure):\/\/([^/]+)\/?(.*)$/i.exec(location);
  if (az) return azurePlace(conn, az[1], az[2]);
  if (SCHEME.test(location) && !/^[a-z]:[\\/]/i.test(location)) {
    throw new Error(`unsupported location '${location}' (http(s), s3://, az://, file:<name>, or a path in Node)`);
  }
  if (type === 's3') {
    const bucket = opt(o, 'bucket');
    if (!bucket) throw new Error(`connection ${conn!.name} has no bucket: use s3://bucket/key`);
    return s3Place(conn, bucket, location);
  }
  if (type === 'azure') {
    const container = opt(o, 'container');
    if (!container) throw new Error(`connection ${conn!.name} has no container: use az://container/path`);
    return azurePlace(conn, container, location);
  }
  const base = opt(o, 'url');
  if (base !== null) return { kind: 'http', url: new URL(location, base.endsWith('/') ? base : `${base}/`).href };
  if (!isNode()) throw new Error(`'${location}' is a local path: in a browser, register the file (registerFile) and use file:<name>`);
  return { kind: 'node', path: location };
}

function s3Place(conn: Connection | undefined, bucket: string, key: string): Place {
  const o = conn?.options;
  const type = conn ? String(o?.type ?? 'http').toLowerCase() : 's3';
  if (type !== 's3') throw new Error(`s3:// locations need an s3 connection (connection ${conn!.name} is ${type})`);
  const endpoint = opt(o, 'endpoint');
  const style = opt(o, 'url_style');
  return { kind: 's3', bucket, key, region: opt(o, 'region') ?? 'us-east-1', endpoint: endpoint && endpoint.replace(/\/+$/, ''), pathStyle: style ? style.toLowerCase() === 'path' : endpoint !== null };
}

function azurePlace(conn: Connection | undefined, container: string, key: string): Place {
  const o = conn?.options;
  const type = conn ? String(o?.type ?? 'http').toLowerCase() : null;
  if (type !== 'azure') throw new Error('az:// locations need an azure connection (it names the storage account)');
  const account = opt(o, 'account');
  const endpoint = opt(o, 'endpoint');
  if (!account) throw new Error(`connection ${conn!.name} has no account`);
  return { kind: 'azure', account, container, key, base: (endpoint ?? `https://${account}.blob.core.windows.net`).replace(/\/+$/, '') };
}

/** The URL of an object (key) in an S3 bucket or Azure container. */
function objectUrl(place: Extract<Place, { kind: 's3' | 'azure' }>, key: string): string {
  if (place.kind === 'azure') return `${place.base}/${place.container}/${encodeKey(key)}`;
  if (place.pathStyle) return `${place.endpoint ?? `https://s3.${place.region}.amazonaws.com`}/${place.bucket}/${encodeKey(key)}`;
  if (place.endpoint) {
    const u = new URL(place.endpoint);
    return `${u.protocol}//${place.bucket}.${u.host}/${encodeKey(key)}`;
  }
  return `https://${place.bucket}.s3.${place.region}.amazonaws.com/${encodeKey(key)}`;
}

// ------------------------------------------------------------------ sources

type Response = Awaited<ReturnType<FetchFn>>;

/** A registered credentials provider; callback ones remember the session that answers for them. */
interface Registered {
  provider: CredentialsProvider | CallbackCredentials;
  session?: string;
}

/** What one engine instance's sources hold: registered files and credentials, the transport. */
class Sources {
  readonly files = new Map<string, FileSource>();
  readonly credentials = new Map<string, Registered>();
  /** Transport for http(s), S3 and Azure requests (default: the global `fetch`). */
  fetchFn: FetchFn | null = null;

  constructor(private readonly host: PluginHost) {}

  /**
   * Whether the location is a pattern: wildcards in a URL's path (`?` starts its query), anywhere
   * in other locations. A location that cannot be resolved is not one: reading it reports why.
   */
  isPattern(target: SourceTarget): boolean {
    let place: Place;
    try {
      place = placeOf(target);
    } catch {
      return false;
    }
    if (place.kind === 'http') return /[*[{]/.test(new URL(place.url).pathname);
    return this.host.glob.isGlob(target.location);
  }

  /** A file to read: its bytes (one GET) or random access (a range probe for the size, then ranges). */
  async open(target: SourceTarget, ctx: SourceContext): Promise<OpenedFile> {
    const place = placeOf(target);
    let close: (() => Promise<void>) | undefined;
    return {
      bytes: () => this.fetchFile(target, place, ctx.signal, false),
      random: async () => {
        const f = await this.openRandom(target, place, ctx.signal);
        close = f.close;
        return f;
      },
      close: async () => {
        await close?.();
      },
    };
  }

  async validator(target: SourceTarget, ctx: SourceContext): Promise<string | null> {
    return (await this.fetchFile(target, placeOf(target), ctx.signal, true)).validator;
  }

  /** The files a pattern matches. */
  async list(target: SourceTarget, ctx: SourceContext): Promise<ListedFile[]> {
    const place = placeOf(target);
    if (place.kind === 'http') throw new Error('wildcards need a source that can be listed (S3, Azure, local paths or registered files), not an HTTP URL');
    if (place.kind === 'file') {
      const re = this.host.glob.regExp(place.name);
      return [...this.files.keys()]
        .filter((n) => re.test(n))
        .sort()
        .map((n) => ({ location: `file:${n}`, path: n }));
    }
    if (place.kind === 'node') return this.listNode(place.path);
    const re = this.host.glob.regExp(place.key);
    const prefix = this.host.glob.prefix(place.key);
    const out: ListedFile[] = [];
    const at = (key: string): string => (place.kind === 's3' ? `s3://${place.bucket}/${key}` : `az://${place.container}/${key}`);
    let token: string | null = null;
    do {
      const listUrl =
        place.kind === 's3'
          ? `${objectUrl(place, '').replace(/\/$/, '')}${place.pathStyle ? '' : '/'}?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`
          : `${place.base}/${place.container}?restype=container&comp=list&prefix=${encodeURIComponent(prefix)}${token ? `&marker=${encodeURIComponent(token)}` : ''}`;
      const res = await this.request(target, place, listUrl, 'GET', ctx.signal);
      const xml = new TextDecoder().decode(await res.arrayBuffer());
      if (place.kind === 's3') {
        for (const c of xmlAll(xml, 'Contents')) {
          const key = xmlTag(c, 'Key')!;
          if (re.test(key)) out.push({ location: at(key), path: key, validator: xmlTag(c, 'ETag') ?? xmlTag(c, 'LastModified') });
        }
        token = xmlTag(xml, 'IsTruncated') === 'true' ? xmlTag(xml, 'NextContinuationToken') : null;
      } else {
        for (const b of xmlAll(xml, 'Blob')) {
          const key = xmlTag(b, 'Name')!;
          if (re.test(key)) out.push({ location: at(key), path: key, validator: xmlTag(b, 'Etag') ?? xmlTag(b, 'Last-Modified') });
        }
        token = xmlTag(xml, 'NextMarker') || null;
      }
    } while (token);
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private async listNode(pattern: string): Promise<ListedFile[]> {
    const fs = await nodeFs();
    const prefix = this.host.glob.prefix(pattern);
    const dir = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : './';
    const re = this.host.glob.regExp(pattern);
    const names = (await fs.readdir(dir, { recursive: true })) as string[];
    const out: ListedFile[] = [];
    for (const n of names.sort()) {
      const path = (dir === './' && !pattern.startsWith('./') ? '' : dir) + n.replace(/\\/g, '/');
      if (!re.test(path)) continue;
      const st = await fs.stat(path);
      if (st.isFile()) out.push({ location: path, path, validator: `${st.mtimeMs}:${st.size}` });
    }
    return out;
  }

  // ---------------------------------------------------------------- fetching

  /** Random access to a file: its size and byte ranges (HTTP Range requests for remote ones). */
  private async openRandom(target: SourceTarget, place: Place, signal?: AbortSignal): Promise<{ file: RandomAccessFile; validator: string | null; close(): Promise<void>; complete: () => boolean }> {
    const none = async (): Promise<void> => undefined;
    const yes = (): boolean => true;
    const fromBytes = (b: Uint8Array): RandomAccessFile => ({ byteLength: b.byteLength, slice: (s, e) => b.slice(s, e).buffer as ArrayBuffer });
    if (place.kind === 'file') {
      const f = this.files.get(place.name);
      if (f === undefined) throw new Error(`no file is registered as '${place.name}' (registerFile)`);
      // Registered files have an exact size: a read that fails would fail again.
      if (typeof f === 'string' || f instanceof Uint8Array || f instanceof ArrayBuffer) return { file: fromBytes((await fileBytes(f)).bytes), validator: null, close: none, complete: yes };
      const blob = 'getFile' in f ? await f.getFile() : f;
      const lm = (blob as { lastModified?: number }).lastModified;
      return { file: { byteLength: blob.size, slice: (s, e) => blob.slice(s, e).arrayBuffer() }, validator: typeof lm === 'number' ? `${lm}:${blob.size}` : null, close: none, complete: yes };
    }
    if (place.kind === 'node') {
      const fs = await nodeFs();
      const h = await fs.open(place.path, 'r');
      const st = await h.stat();
      return {
        file: {
          byteLength: st.size,
          slice: async (s, e = st.size) => {
            const b = new Uint8Array(e - s);
            await h.read(b, 0, b.length, s);
            return b.buffer;
          },
        },
        validator: `${st.mtimeMs}:${st.size}`,
        close: () => h.close(),
        complete: yes, // a local file's size is exact
      };
    }
    const url = place.kind === 'http' ? place.url : objectUrl(place, place.key);
    // The size comes from a 1-byte range probe, not HEAD: on hosts that compress responses (GitHub
    // Pages, CDNs), HEAD's Content-Length is the compressed size while ranges address the
    // uncompressed bytes. Browsers request range responses with `identity` encoding.
    const probe = await this.request(target, place, url, 'GET', signal, { range: 'bytes=0-0' }, [416]);
    let validator = probe.headers.get('etag') ?? probe.headers.get('last-modified');
    const body = new Uint8Array(await probe.arrayBuffer());
    // 200: the server ignored the range and sent the whole file.
    if (probe.status === 200) return { file: fromBytes(body), validator, close: none, complete: yes };
    // 416: no byte 0, an empty file; read it as one (the format then reports what is wrong with it).
    if (probe.status === 416) {
      const f = await this.fetchFile(target, place, signal, false);
      return { file: fromBytes(f.bytes), validator: validator ?? f.validator, close: none, complete: yes };
    }
    const total = /^bytes\s+\d+-\d+\/(\d+)\s*$/i.exec(probe.headers.get('content-range') ?? '');
    const size = total ? Number(total[1]) : NaN;
    if (!Number.isSafeInteger(size)) {
      // No total size (`*`, or Content-Range not exposed to the page by CORS): read the whole file once.
      const f = await this.fetchFile(target, place, signal, false);
      validator ??= f.validator;
      return { file: fromBytes(f.bytes), validator, close: none, complete: yes };
    }
    let whole: Promise<Uint8Array> | null = null;
    return {
      file: {
        byteLength: size,
        slice: async (s, e = size) => {
          if (whole) return (await whole).slice(s, e).buffer as ArrayBuffer;
          const res = await this.request(target, place, url, 'GET', signal, { range: `bytes=${s}-${e - 1}` });
          if (res.status === 206) return res.arrayBuffer();
          // The server ignored the range: keep the whole body for the other slices.
          whole = res.arrayBuffer().then((b) => new Uint8Array(b));
          return (await whole).slice(s, e).buffer as ArrayBuffer;
        },
      },
      validator,
      close: none,
      // A slice that got the whole body (the server ignored a later range) holds the whole file.
      complete: () => whole !== null,
    };
  }

  /** One file's bytes (or, with `head`, only its validator). */
  private async fetchFile(target: SourceTarget, place: Place, signal: AbortSignal | undefined, head: boolean): Promise<{ bytes: Uint8Array; validator: string | null }> {
    if (place.kind === 'file') {
      const f = this.files.get(place.name);
      if (f === undefined) throw new Error(`no file is registered as '${place.name}' (registerFile)`);
      return fileBytes(f, head);
    }
    if (place.kind === 'node') {
      const fs = await nodeFs();
      const [bytes, st] = await Promise.all([head ? new Uint8Array(0) : fs.readFile(place.path), fs.stat(place.path)]);
      return { bytes, validator: `${st.mtimeMs}:${st.size}` };
    }
    const url = place.kind === 'http' ? place.url : objectUrl(place, place.key);
    const res = await this.request(target, place, url, head ? 'HEAD' : 'GET', signal);
    const bytes = head ? new Uint8Array(0) : new Uint8Array(await res.arrayBuffer());
    return { bytes, validator: res.headers.get('etag') ?? res.headers.get('last-modified') };
  }

  /** The credential material of registered credentials `name` for one request. */
  private async material(name: string, r: Registered, url: string, method: 'GET' | 'HEAD'): Promise<CredentialMaterial> {
    const p = r.provider;
    if (!('callback' in p) || !p.callback) return materialOf(p as CredentialsProvider, url, method);
    // A callback in the registering client session (a tab): ask it.
    try {
      return ((await this.host.ask(r.session ?? 'local', { name, url, method } satisfies CredentialsQuestion, ASK_TIMEOUT_MS)) ?? {}) as CredentialMaterial;
    } catch (e) {
      const a = e as Partial<AskError>;
      const why =
        a.reason === 'timeout'
          ? `the provider did not answer within ${ASK_TIMEOUT_MS / 1000} s`
          : a.reason === 'closed'
            ? 'the tab that provides them closed'
            : a.reason === 'failed'
              ? (a.detail ?? 'no credentials')
              : a.reason === 'no-session'
                ? 'there is no client session to ask'
                : ((e as Error)?.message ?? String(e));
      throw new Error(`credentials '${name}': ${why}`);
    }
  }

  /**
   * One HTTP request: with the connection's credentials (only for URLs under the provider's
   * endpoint), signed for S3 (SigV4) or Azure (SAS, Shared Key, bearer), or to a presigned URL.
   */
  private async request(target: SourceTarget, place: Place, url: string, method: 'GET' | 'HEAD', signal?: AbortSignal, extra: Record<string, string> = {}, accept: number[] = []): Promise<Response> {
    let headers: Record<string, string> = { ...extra };
    let to = url;
    const credName = target.connection?.options.credentials;
    if (credName !== undefined && credName !== null) {
      const r = this.credentials.get(String(credName));
      if (!r) throw new Error(`connection ${target.connection!.name}: no credentials are registered as '${credName}' (registerCredentials)`);
      if (!url.startsWith(r.provider.endpoint)) throw new Error(`credentials '${credName}' are bound to ${r.provider.endpoint}; refusing to send them to ${url}`);
      let m: CredentialMaterial;
      try {
        m = await this.material(String(credName), r, url, method);
      } catch (e) {
        throw new Error((e as Error)?.message ?? String(e)); // a provider that failed or refused
      }
      headers = { ...m.headers, ...extra };
      if (m.url) to = m.url;
      else if (m.aws && place.kind === 's3') headers = await signV4({ method, url, headers }, m.aws, place.region, 's3');
      else if (m.azure && place.kind === 'azure') {
        const a = m.azure;
        if ('sasToken' in a) to = `${url}${url.includes('?') ? '&' : '?'}${a.sasToken.replace(/^\?/, '')}`;
        else if ('accountKey' in a) headers = await signAzureSharedKey({ method, url, headers }, place.account, a.accountKey);
        else headers = { ...headers, authorization: `Bearer ${a.bearerToken}`, 'x-ms-version': AZURE_VERSION };
      } else if (m.aws || m.azure) throw new Error(`credentials '${credName}' hold ${m.aws ? 'AWS' : 'Azure'} keys, but ${url} is not on a ${m.aws ? 's3' : 'azure'} connection`);
    } else if (place.kind === 'azure') headers['x-ms-version'] = AZURE_VERSION;
    const fetchFn = this.fetchFn ?? (globalThis.fetch as unknown as FetchFn | undefined);
    if (!fetchFn) throw new Error('no fetch available in this environment');
    let res: Response;
    try {
      signal?.throwIfAborted(); // aborted while the request was being prepared
      res = await fetchFn(to, method === 'HEAD' ? { method, headers, signal } : { headers, signal });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e; // the engine reports SMALT_INTERRUPT
      throw new Error(`fetching ${url} failed: ${(e as Error)?.message} (a network error, or a CORS error: the server must allow this origin)`);
    }
    if (!res.ok && !accept.includes(res.status)) {
      let detail = '';
      if (method !== 'HEAD') {
        // S3 and Azure explain errors in an XML body (<Code>AccessDenied</Code>, <Message>…</Message>).
        const body = new TextDecoder().decode(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
        const code = xmlTag(body, 'Code');
        if (code) detail = ` (${code}${xmlTag(body, 'Message') ? `: ${xmlTag(body, 'Message')}` : ''})`;
      }
      throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} for ${url}${detail}`);
    }
    return res;
  }
}

type NodeFs = {
  readFile(p: string): Promise<Uint8Array>;
  stat(p: string): Promise<{ mtimeMs: number; size: number; isFile(): boolean }>;
  readdir(p: string, o: { recursive: boolean }): Promise<string[]>;
  open(
    p: string,
    flags: string,
  ): Promise<{ stat(): Promise<{ mtimeMs: number; size: number }>; read(b: Uint8Array, off: number, len: number, pos: number): Promise<unknown>; close(): Promise<void> }>;
};

/** Node's fs (loaded on first use; never bundled for browsers). */
async function nodeFs(): Promise<NodeFs> {
  const name = 'node:fs/promises';
  return (await import(/* @vite-ignore */ name)) as NodeFs;
}

/** A registered file's bytes and validator (a File's lastModified and size; none for Blobs and bytes). */
async function fileBytes(f: FileSource, head = false): Promise<{ bytes: Uint8Array; validator: string | null }> {
  if (typeof f === 'string') return { bytes: new TextEncoder().encode(f), validator: null };
  if (f instanceof Uint8Array) return { bytes: f, validator: null };
  if (f instanceof ArrayBuffer) return { bytes: new Uint8Array(f), validator: null };
  const blob = 'getFile' in f ? await f.getFile() : f;
  const lastModified = (blob as { lastModified?: number }).lastModified;
  const validator = typeof lastModified === 'number' ? `${lastModified}:${blob.size}` : null;
  return { bytes: head ? new Uint8Array(0) : new Uint8Array(await blob.arrayBuffer()), validator };
}
