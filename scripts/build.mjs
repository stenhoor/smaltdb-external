// Builds the plugin: dist/index.js (the plugin, for the engine), dist/client.js (the helpers, when src/client.ts
// exists) and their declarations. Dependencies are never bundled: they stay imports, installed by npm with their own
// licences (smaltdb ADR 0012).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

rmSync('dist', { recursive: true, force: true });
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const external = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}), 'smaltdb/*'];
await build({
  entryPoints: ['src/index.ts', ...(existsSync('src/client.ts') ? ['src/client.ts'] : [])],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
  external,
  define: { __PLUGIN_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'warning',
});
// Declarations are checked against smaltdb's published types (node_modules/smaltdb), not its source.
writeFileSync(
  'tsconfig.build.json',
  JSON.stringify({
    extends: './tsconfig.json',
    compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: 'dist', rootDir: 'src', paths: {} },
    include: ['src'],
  }),
);
try {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
} finally {
  rmSync('tsconfig.build.json');
}
console.log(`built ${pkg.name}`);
