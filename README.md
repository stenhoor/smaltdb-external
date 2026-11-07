# @smaltdb/external

<a href="https://smaltworks.dev/stability"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/stenhoor/smalt-brand/main/badges/work-in-progress-on-dark.svg"><img alt="Work in progress. Come build with us." src="https://raw.githubusercontent.com/stenhoor/smalt-brand/main/badges/work-in-progress.svg" height="56"></picture></a>

[Writing plugins](https://smaltdb.dev/reference/api/plugins) · [smaltworks.dev](https://smaltworks.dev/products/plugins)

External data sources for [smaltdb](https://github.com/stenhoor/smaltdb) external tables and `read_*()` functions:

- `https://…` and `http://…` URLs, and locations relative to a connection's `url`;
- `s3://bucket/key` on Amazon S3 and S3-compatible stores, signed with Signature Version 4;
- `az://container/blob` on Azure Blob Storage, with SAS tokens, Shared Key or bearer tokens;
- `file:<name>`: files the application registers (a `File`, a `Blob`, a file handle, bytes or text);
- plain paths on the Node file system.

Patterns (`*`, `**`, `?`, `[…]`, `{a,b}`) are listed on S3, Azure, registered files and local paths. It also
provides the `http`, `s3` and `azure` connection types for `CREATE CONNECTION`. No runtime dependencies.

```sh
npm install smaltdb @smaltdb/external @smaltdb/io
```

A source needs a format: install `@smaltdb/io` for CSV and JSON, `@smaltdb/parquet` for Parquet. In the browser,
install the plugins in your engine worker entry and open the database with that worker:

```ts
// db-worker.ts
import { serve } from 'smaltdb/worker-runtime';
import external from '@smaltdb/external';
import io from '@smaltdb/io';

serve({ plugins: [external, io] });
```

```ts
import { open } from 'smaltdb';
import { registerCredentials, registerFile } from '@smaltdb/external/client';

const db = await open('app', {
  worker: () => new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' }),
});
await registerFile(db, 'upload.csv', fileInput.files[0]);
const rows = await db.query("SELECT * FROM read_csv('file:upload.csv')");

// Credentials are sent only to URLs under `endpoint`. Functions stay in this tab and are asked per request.
await registerCredentials(db, 'aws', { endpoint: 'https://my-bucket.s3.eu-west-1.amazonaws.com/', aws: () => getKeys() });
await db.exec("CREATE CONNECTION lake WITH (type = 's3', region = 'eu-west-1', bucket = 'my-bucket', credentials = 'aws')");
```

With the in-process engine (Node): `Database.openMemory({ plugins: [external, io] })` from `smaltdb/engine`; the same
helpers take that database too, and `setFetch(db, fn)` replaces the transport.

See the [plugins guide](https://github.com/stenhoor/smaltdb/blob/main/docs/guide/plugins.md). MIT licence.

## Development

```sh
npm ci && npm run deps   # deps: the pinned smaltdb, @smaltdb/io and @smaltdb/parquet builds from packed.json
npm run check            # type-check and test
```

See [CLAUDE.md](CLAUDE.md) for how the pins work.

<a href="https://smaltworks.dev"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/stenhoor/smalt-brand/main/badges/a-smaltworks-project-on-dark.svg"><img alt="A smaltworks project" src="https://raw.githubusercontent.com/stenhoor/smalt-brand/main/badges/a-smaltworks-project.svg" height="28"></picture></a>

MIT License.
