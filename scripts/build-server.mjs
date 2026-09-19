#!/usr/bin/env node
/**
 * Builds the server into one file: `server/freo-server.mjs`.
 *
 *     node scripts/build-server.mjs
 *
 * One file because of the sentence in `docs/server.md` that decides everything else:
 * the plan is to copy this onto a machine at work and start it. A `node_modules` tree
 * is not something you hand to a person standing in a shop — it is a hundred megabytes
 * of somebody else's code that has to be installed on a box that may not have network
 * access, and it is the reason "just move it to the office machine" usually turns into
 * a day. With one `.mjs` file the transfer is `scp`, the dependency list is "Node 20",
 * and the Docker image copies one file instead of running an install.
 *
 * No minification, and a sourcemap. This runs on a box that will be debugged by
 * whoever is nearest to it, at 6am, over SSH. A stack trace that points at
 * `server.ts:118` is worth more than 40 KB nobody in this shop will miss; a single
 * line of mangled code is worth nothing to anyone.
 *
 * The version goes in at build time as `globalThis.__FREO_VERSION__`, which is why
 * `/api/health` can name its build on a box that has no `package.json` near it.
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, realpathSync, statSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version ?? 'unknown';

/**
 * Find esbuild.
 *
 * It is not a direct dependency of this project — it arrives with Vite — so in a pnpm
 * install there is no top-level `node_modules/esbuild` to import, and the honest way
 * to get it is to ask the package that depends on it. Resolving through Vite's own
 * `package.json` follows whatever layout the lockfile produced today rather than
 * hard-coding a `.pnpm/esbuild@0.28.2` path that rots on the next upgrade.
 *
 * If this ever fails, the fix is one line in `package.json`, not a different bundler.
 */
async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch {
    // Present, just not at the top level.
  }
  const vitePackage = import.meta.resolve('vite/package.json');
  const requireFromVite = createRequire(realpathSync(fileURLToPath(vitePackage)));
  return import(pathToFileURL(requireFromVite.resolve('esbuild')).href);
}

const esbuild = await loadEsbuild();

const outdir = resolve(root, 'server');
const outfile = resolve(outdir, 'freo-server.mjs');

const result = await esbuild.build({
  entryPoints: [resolve(root, 'server/src/index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  // Matches `engines.node` in `package.json`. Anything newer than this in the
  // dependency tree will be polyfilled or left alone, and a box running Node 20 must
  // not fail on syntax it has never seen.
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  minify: false,
  // `node:http` and friends stay as imports: they are the reason the file runs without
  // a dependency install, and bundling a shim for a built-in module is how a server
  // ends up carrying a fake `fs`.
  external: ['node:*'],
  define: { 'globalThis.__FREO_VERSION__': JSON.stringify(version) },
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});

const bytes = statSync(outfile).size;
const inputs = Object.keys(result.metafile?.inputs ?? {}).length;

process.stdout.write(`server/freo-server.mjs — ${version}, ${formatSize(bytes)}, from ${String(inputs)} files\n`);
process.stdout.write(`  ${outfile}\n`);

function formatSize(size) {
  return `${(size / 1024).toFixed(1)} kB`;
}
