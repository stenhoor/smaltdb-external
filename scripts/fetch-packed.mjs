// Installs pinned builds of smaltdb packages that are not on npm yet (ADR 0012, "Before the first publish").
//
// packed.json pins each package to a commit of its repository:
//   { "smaltdb": { "repo": "stenhoor/smaltdb", "ref": "<sha>" },
//     "@smaltdb/io": { "repo": "stenhoor/smaltdb-io", "ref": "<sha>" } }
// An entry may add "dir" (the package is a folder of a monorepo, built from the repository root) and "keep" (paths of
// the checkout to keep next to the tarball, in .cache/packed/<name>-<ref>-files, e.g. ["docs"]), or be { "path": "." }:
// this checkout is that package, used to build the others but not installed into itself.
//
// For each pin the script checks out the commit, builds it, runs `npm pack`, and finally installs every tarball with
// `npm install --no-save`, so nothing reaches package.json or the lockfile. Tarballs are cached in .cache/packed by
// commit. Every later `npm ci` or `npm install` removes them again: run this script after each one.
//
//   node scripts/fetch-packed.mjs                       install the pinned packages
//   node scripts/fetch-packed.mjs --check               fail, naming this script, if one is not installed
//   node scripts/fetch-packed.mjs --local NAME=PATH     build NAME from a local checkout instead of its pin
//
// This file is identical in smaltdb, smaltdb-io, smaltdb-external and smaltdb-parquet. It is deleted when 0.9.0 is
// published and the pins become ordinary ^0.9.0 dependencies.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const pins = JSON.parse(readFileSync(join(root, 'packed.json'), 'utf8'));
const cache = join(root, '.cache/packed');
const args = process.argv.slice(2);
const local = new Map();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--local') {
    const [name, path] = (args[++i] ?? '').split('=');
    if (!name || !path || !(name in pins)) fail(`--local needs NAME=PATH with a NAME from packed.json`);
    local.set(name, resolve(path));
  }
}

if (args.includes('--check')) {
  const missing = Object.entries(pins)
    .filter(([name, pin]) => !pin.path && !existsSync(join(root, 'node_modules', name, 'package.json')))
    .map(([name]) => name);
  if (missing.length > 0) {
    fail(`${missing.join(', ')} not installed: run \`node scripts/fetch-packed.mjs\` (again after every npm ci or npm install)`);
  }
  process.exit(0);
}

mkdirSync(cache, { recursive: true });
const tarballs = new Map();
// smaltdb first: the plugins are built against it.
const order = Object.keys(pins).sort((a, b) => (a === 'smaltdb' ? -1 : b === 'smaltdb' ? 1 : 0));
for (const name of order) tarballs.set(name, pack(name, pins[name]));
const install = order.filter((name) => !pins[name].path).map((name) => tarballs.get(name));
if (install.length > 0) run('npm', ['install', '--no-save', '--no-audit', '--no-fund', ...install], root);
console.log(`fetch-packed: installed ${order.filter((name) => !pins[name].path).join(', ') || 'nothing'}`);

function pack(name, pin) {
  const slug = name.replace(/^@/, '').replace(/\//g, '-');
  if (local.has(name) || pin.path) {
    const dir = local.get(name) ?? resolve(root, pin.path);
    build(name, dir, dir);
    return npmPack(dir);
  }
  if (!pin.repo || !/^[0-9a-f]{40}$/.test(pin.ref ?? '')) fail(`${name}: a pin needs "repo" and a full 40-character commit "ref"`);
  const tgz = join(cache, `${slug}-${pin.ref}${pin.dir ? `-${pin.dir.replace(/\//g, '-')}` : ''}.tgz`);
  const kept = join(cache, `${slug}-${pin.ref}-files`);
  const keep = pin.keep ?? [];
  if (existsSync(tgz) && keep.every((p) => existsSync(join(kept, p)))) return tgz;
  const src = join(cache, 'src', `${pin.repo.replace('/', '-')}-${pin.ref}`);
  if (!existsSync(join(src, 'package.json'))) {
    rmSync(src, { recursive: true, force: true });
    mkdirSync(src, { recursive: true });
    run('git', ['init', '-q'], src);
    run('git', ['fetch', '-q', '--depth', '1', `https://github.com/${pin.repo}.git`, pin.ref], src);
    run('git', ['checkout', '-q', 'FETCH_HEAD'], src);
  }
  for (const p of keep) cpSync(join(src, p), join(kept, p), { recursive: true });
  if (existsSync(tgz)) return tgz;
  const dir = pin.dir ? join(src, pin.dir) : src;
  build(name, src, dir);
  const packed = npmPack(dir);
  run('mv', [packed, tgz], root);
  return tgz;
}

// A monorepo or smaltdb builds from its root. A plugin repository is built against the smaltdb tarball.
function build(name, repoRoot, dir) {
  // This checkout is already installed; `npm ci` here would also remove what this script installs.
  if (repoRoot !== root) run('npm', ['ci', '--no-audit', '--no-fund'], repoRoot);
  if (repoRoot === dir && name !== 'smaltdb') {
    const core = tarballs.get('smaltdb');
    if (!core) fail(`${name}: building a plugin needs a "smaltdb" pin in packed.json`);
    run('npm', ['install', '--no-save', '--no-audit', '--no-fund', core], repoRoot);
  }
  run('npm', ['run', 'build'], repoRoot);
}

function npmPack(dir) {
  const out = execFileSync('npm', ['pack', '--json', '--pack-destination', cache], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return join(cache, JSON.parse(out)[0].filename);
}

function run(cmd, argv, cwd) {
  execFileSync(cmd, argv, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
}

function fail(message) {
  console.error(`fetch-packed: ${message}`);
  process.exit(1);
}
