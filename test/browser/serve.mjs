// Tiny static server with cross-origin isolation headers, shared by browser tests and benchmarks.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.data': 'application/octet-stream' };

/**
 * Serve `roots` (url prefix -> directory). `handle(req, res)`, when given, is asked first and returns
 * true for requests it answered. Returns { url, close }.
 */
export async function serve(roots, { isolated = true, handle } = {}) {
  const server = createServer(async (req, res) => {
    if (handle && (await handle(req, res))) return;
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    for (const [prefix, dir] of Object.entries(roots)) {
      if (!path.startsWith(prefix)) continue;
      const file = normalize(join(dir, path.slice(prefix.length) || 'index.html'));
      if (!file.startsWith(normalize(dir))) break;
      try {
        const body = await readFile(file);
        const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' };
        if (isolated) {
          headers['cross-origin-opener-policy'] = 'same-origin';
          headers['cross-origin-embedder-policy'] = 'require-corp';
          headers['cross-origin-resource-policy'] = 'same-origin';
        }
        res.writeHead(200, headers);
        res.end(body);
        return;
      } catch {
        break;
      }
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
