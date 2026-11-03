/** Types shared by the plugin (src/index.ts) and its client helpers (src/client.ts). */

/** AWS keys: requests on s3 connections are signed with Signature Version 4. */
export interface AwsKeys {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials (STS, Cognito). */
  sessionToken?: string;
}

/** How a request to Azure Blob Storage authenticates. */
export type AzureAuth = { sasToken: string } | { accountKey: string } | { bearerToken: string };

/** A file the application registers under a name (`file:<name>` locations). */
export type FileSource = Blob | Uint8Array | ArrayBuffer | string | { getFile(): Promise<Blob> };

/** What authenticates one request: headers, keys to sign it with, or a presigned URL to use instead. */
export interface CredentialMaterial {
  headers?: Record<string, string>;
  aws?: AwsKeys;
  azure?: AzureAuth;
  /** A presigned URL (S3, Azure SAS, GCS): fetched instead of the request URL, with no other auth. */
  url?: string;
}

/**
 * Credentials for connections (`CREATE CONNECTION … WITH (credentials = '<name>')`), registered at
 * runtime (never stored in SQL or the database file). They are only used for URLs that start with
 * `endpoint`, so a database file from elsewhere cannot point a connection at another host and collect
 * them. Each part may be a value or a function, called per request (tokens that expire, keys from
 * STS or Cognito). In a browser tab, functions stay in the tab: the engine worker asks it for each
 * request.
 */
export interface CredentialsProvider {
  endpoint: string;
  /** Extra headers (`authorization: Bearer …`). */
  headers?: Record<string, string> | ((url: string) => Record<string, string> | Promise<Record<string, string>>);
  /** AWS keys: requests to S3 connections are signed with Signature Version 4. */
  aws?: AwsKeys | (() => AwsKeys | Promise<AwsKeys>);
  /** Azure: a SAS token, the account key (Shared Key signing) or an Entra ID bearer token. */
  azure?: AzureAuth | (() => AzureAuth | Promise<AzureAuth>);
  /** Issues a presigned URL for a request (the URL to use instead). */
  presign?: (url: string, method: 'GET' | 'HEAD') => string | Promise<string>;
}

/** Credentials whose material the engine asks the registering client session for, per request. */
export interface CallbackCredentials {
  endpoint: string;
  callback: true;
}

/** The question the engine asks a client session for callback credentials. */
export interface CredentialsQuestion {
  name: string;
  url: string;
  method: 'GET' | 'HEAD';
}

/** The subset of `fetch` the sources use (injectable for tests and custom transports). */
export type FetchFn = (
  url: string,
  init: { method?: 'GET' | 'HEAD'; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** The material of `p` for one request (functions are called). */
export async function materialOf(p: CredentialsProvider, url: string, method: 'GET' | 'HEAD'): Promise<CredentialMaterial> {
  return {
    headers: typeof p.headers === 'function' ? await p.headers(url) : p.headers,
    aws: typeof p.aws === 'function' ? await p.aws() : p.aws,
    azure: typeof p.azure === 'function' ? await p.azure() : p.azure,
    url: p.presign ? await p.presign(url, method) : undefined,
  };
}
