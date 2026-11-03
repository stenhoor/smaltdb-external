/**
 * Request signing for object stores (M8.2), on WebCrypto (browsers, workers and Node 20+), so the plugin
 * needs no dependency:
 * - AWS Signature Version 4 (S3 and S3-compatible stores: MinIO, Cloudflare R2, …);
 * - Azure Storage Shared Key (blob service).
 */

const enc = new TextEncoder();

const toHex = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

/** RFC 3986 percent-encoding (what SigV4 expects in canonical query strings). */
const rfc3986 = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** SHA-256 of an empty body (GET / HEAD requests). */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface AwsKeys {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials (STS, Cognito). */
  sessionToken?: string;
}

/**
 * Sign a request with AWS Signature Version 4. Returns the headers to send (the given ones plus
 * `x-amz-date`, the content hash for S3, the session token and `authorization`). The `host` header
 * is signed but not returned: fetch sets it.
 */
export async function signV4(
  req: { method: string; url: string; headers?: Record<string, string> },
  keys: AwsKeys,
  region: string,
  service: string,
  now: Date = new Date(),
): Promise<Record<string, string>> {
  const u = new URL(req.url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) out[k.toLowerCase()] = v;
  out['x-amz-date'] = amzDate;
  if (service === 's3') out['x-amz-content-sha256'] ??= EMPTY_SHA256;
  if (keys.sessionToken) out['x-amz-security-token'] = keys.sessionToken;
  const signed: Record<string, string> = { ...out, host: u.host };
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const query = [...u.searchParams]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  // S3 paths are signed as sent (encoded once); other services normalize them the same way here.
  const canonicalRequest = [req.method, u.pathname || '/', query, canonicalHeaders, names.join(';'), out['x-amz-content-sha256'] ?? EMPTY_SHA256].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const kDate = await hmac(enc.encode('AWS4' + keys.secretAccessKey), day);
  const kSigning = await hmac(await hmac(await hmac(kDate, region), service), 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));
  out.authorization = `AWS4-HMAC-SHA256 Credential=${keys.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return out;
}

/** The Azure Storage REST API version requests are made with. */
export const AZURE_VERSION = '2021-08-06';

const base64 = (b: ArrayBuffer): string => {
  let s = '';
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s);
};
const fromBase64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Sign a blob-service request with an Azure Storage account key (Shared Key). Returns the headers to
 * send: the given ones plus `x-ms-date`, `x-ms-version` and `authorization`.
 */
export async function signAzureSharedKey(
  req: { method: string; url: string; headers?: Record<string, string> },
  account: string,
  accountKey: string,
  now: Date = new Date(),
): Promise<Record<string, string>> {
  const u = new URL(req.url);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) out[k.toLowerCase()] = v;
  out['x-ms-date'] = now.toUTCString();
  out['x-ms-version'] ??= AZURE_VERSION;
  const h = (n: string): string => out[n] ?? '';
  const msHeaders = Object.keys(out)
    .filter((n) => n.startsWith('x-ms-'))
    .sort()
    .map((n) => `${n}:${out[n].trim()}\n`)
    .join('');
  const params = new Map<string, string[]>();
  for (const [k, v] of u.searchParams) params.set(k.toLowerCase(), [...(params.get(k.toLowerCase()) ?? []), v]);
  const resource =
    `/${account}${u.pathname || '/'}` +
    [...params.keys()]
      .sort()
      .map((k) => `\n${k}:${params.get(k)!.sort().join(',')}`)
      .join('');
  const contentLength = h('content-length') === '0' ? '' : h('content-length');
  const stringToSign = [
    req.method,
    h('content-encoding'),
    h('content-language'),
    contentLength,
    h('content-md5'),
    h('content-type'),
    '', // Date (x-ms-date is used)
    h('if-modified-since'),
    h('if-match'),
    h('if-none-match'),
    h('if-unmodified-since'),
    h('range'),
    msHeaders + resource,
  ].join('\n');
  out.authorization = `SharedKey ${account}:${base64(await hmac(fromBase64(accountKey), stringToSign))}`;
  return out;
}
