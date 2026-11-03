/**
 * Helpers for applications using @smaltdb/external. Each takes the database: a client `Database`
 * (`smaltdb`, the engine in a worker) or an engine `Database` (`smaltdb/engine`, in-process).
 */
import { type CredentialMaterial, type CredentialsProvider, type CredentialsQuestion, type FetchFn, type FileSource, materialOf } from './types.js';

export type { AwsKeys, AzureAuth, CredentialsProvider, FetchFn, FileSource } from './types.js';

/** What the helpers need of a database: a client `Database` or an engine `Database`. */
export interface PluginCaller {
  callPlugin(plugin: string, method: string, args: unknown[], options?: { lock?: boolean; replay?: string; dropReplay?: boolean; signal?: AbortSignal }): Promise<unknown>;
  onPluginMessage?(plugin: string, handler: ((message: unknown) => unknown) | null): void;
}

const PLUGIN = '@smaltdb/external';

/**
 * Make a file readable by SQL as `file:<name>`: a `File` from an `<input type="file">`, a File
 * System Access handle, a Blob, bytes or text. `CREATE EXTERNAL TABLE t WITH (location = 'file:<name>')`
 * or `read_csv('file:<name>')`. Pass null to remove it. Files are not stored in the database.
 */
export async function registerFile(db: PluginCaller, name: string, file: FileSource | null): Promise<void> {
  await db.callPlugin(PLUGIN, 'registerFile', [name, file], { replay: 'file:' + name, dropReplay: file === null });
}

/** This tab's credentials providers with functions, by database (the engine asks them per request). */
const tabProviders = new WeakMap<PluginCaller, Map<string, CredentialsProvider>>();

const hasFunction = (p: CredentialsProvider): boolean => typeof p.headers === 'function' || typeof p.aws === 'function' || typeof p.azure === 'function' || p.presign !== undefined;

/**
 * Credentials that connections name (`CREATE CONNECTION c WITH (url = …, credentials = '<name>')`):
 * used only for requests to URLs that start with `provider.endpoint`. They live in the engine's
 * memory, never in SQL or the database file. Parts that are functions stay in this tab: the engine
 * asks them for each request. Pass null to remove them.
 */
export async function registerCredentials(db: PluginCaller, name: string, provider: CredentialsProvider | null): Promise<void> {
  let sent: unknown = provider;
  if (db.onPluginMessage) {
    let mine = tabProviders.get(db);
    if (provider && hasFunction(provider)) {
      if (!mine) {
        const providers = new Map<string, CredentialsProvider>();
        mine = providers;
        tabProviders.set(db, providers);
        db.onPluginMessage(PLUGIN, (m) => answer(providers, m as CredentialsQuestion));
      }
      mine.set(name, provider);
      sent = { endpoint: provider.endpoint, callback: true };
    } else mine?.delete(name);
  }
  await db.callPlugin(PLUGIN, 'registerCredentials', [name, sent], { replay: 'cred:' + name, dropReplay: provider === null });
}

/** The engine asks for the credentials of one request. */
async function answer(providers: Map<string, CredentialsProvider>, q: CredentialsQuestion): Promise<CredentialMaterial> {
  const p = providers.get(q.name);
  if (!p) throw new Error('not registered in this tab');
  return materialOf(p, q.url, q.method);
}

/**
 * The transport for http(s), S3 and Azure requests (default: the global `fetch`); null restores the
 * default. A function cannot cross to a worker: this is for the in-process engine (tests, custom transports).
 */
export async function setFetch(db: PluginCaller, fetchFn: FetchFn | null): Promise<void> {
  await db.callPlugin(PLUGIN, 'setFetch', [fetchFn]);
}
