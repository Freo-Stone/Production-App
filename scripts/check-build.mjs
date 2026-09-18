#!/usr/bin/env node
/**
 * Checks a build before it is published.
 *
 *     node scripts/check-build.mjs [/<base>/]      # root is dist/, base defaults to /
 *
 * Why this exists instead of a few greps in the workflow: the workflow used to
 * assert that `dist/index.html` mentions the base path and that the manifest and
 * service worker files exist. Every one of those could pass while the app was
 * broken on a phone — a manifest that returns 200 and lists icons that were never
 * copied into the artifact is exactly that, and an install prompt is the one place
 * a missing file is not visible in the browser console.
 *
 * So this resolves things rather than mentioning them: every reference in the page,
 * every reference in the manifest, and the sizes an installer asks for. It also
 * enforces the one rule that matters commercially — nothing but the build output
 * may ever be published, so a state document or a MYOB export appearing anywhere
 * under `dist/` fails the build outright.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';

const root = resolve('dist');
const base = process.argv[2] ?? '/';
const failures = [];
const notes = [];

function check(ok, what, detail = '') {
  if (ok) notes.push(`  ok   ${what}${detail ? ` — ${detail}` : ''}`);
  else failures.push(`  FAIL ${what}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/**
 * Reference to a path on disk, or null for something that lives elsewhere.
 *
 * Manifest icon sources are written bare ("icon-192.png"), so anything that is not
 * a URL resolves against the build output. Treating a bare name as remote — which
 * is what this did first — makes every icon check pass while checking nothing.
 */
function diskPath(ref) {
  const clean = ref.split(/[?#]/)[0];
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)) return null; // http:, data:, //host/…
  if (base !== '/' && clean.startsWith(base)) return join(root, clean.slice(base.length) || '.');
  if (isAbsolute(clean)) return join(root, clean.replace(/^\/+/, '') || '.');
  return resolve(root, clean);
}

function fileOk(ref, why) {
  const p = diskPath(ref);
  if (p === null) return true;
  if (!existsSync(p)) return check(false, `${why}: ${ref}`, 'not in the build output');
  const size = statSync(p).size;
  return check(size > 0, `${why}: ${ref}`, `${size} bytes`);
}

function pngSize(path) {
  const b = readFileSync(path);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

if (!existsSync(join(root, 'index.html'))) {
  console.error(`check-build: no dist/index.html — run \`pnpm run build\` first (base "${base}").`);
  process.exit(1);
}

const html = readFileSync(join(root, 'index.html'), 'utf8');

// 1. Everything the page itself points at.
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
const local = refs.filter((r) => diskPath(r) !== null);
for (const ref of local) fileOk(ref, 'page reference');
check(
  local.some((r) => r.startsWith(`${base}assets/`) && r.endsWith('.js')),
  'page loads its bundle under the site base',
  base,
);
check(
  /<div id="root"/.test(html) && /type="module"/.test(html),
  'page has a root to mount into and a module entry',
);
// A page built with the wrong base loads and stays blank, which is the expensive
// failure mode: it looks like a browser problem from the shop floor.
check(html.includes(`${base}assets/`), 'asset URLs carry the site base', base);

// 2. The manifest, and what it promises an installer.
const manifestPath = join(root, 'manifest.webmanifest');
if (check(existsSync(manifestPath), 'manifest exists')) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    check(false, 'manifest parses', String(error.message));
  }
  if (manifest) {
    check(Boolean(manifest.name) && Boolean(manifest.short_name), 'manifest names the app', manifest.name);
    check(manifest.display === 'standalone', 'manifest asks to run standalone', manifest.display);
    for (const icon of manifest.icons ?? []) fileOk(icon.src, 'manifest icon');
    const start = manifest.start_url;
    if (!start) check(false, 'manifest start_url', 'an installed app needs one');
    else if (start === '.' || start === './')
      // The app is a hash router, so the whole app lives on the entry page; the
      // manifest points at the directory it sits in rather than a path of its own.
      check(existsSync(join(root, 'index.html')), 'manifest start_url points at the built page', start);
    else fileOk(start, 'manifest start_url');

    const pngs = (manifest.icons ?? []).filter((i) => (i.type ?? '') === 'image/png');
    const any = pngs.filter((i) => (i.purpose ?? 'any').includes('any'));
    const maskable = pngs.filter((i) => (i.purpose ?? '') === 'maskable');
    const big = any.filter((i) => {
      const p = diskPath(i.src);
      const size = p && existsSync(p) ? pngSize(p) : null;
      return size && Math.min(size.width, size.height) >= 512;
    });
    // Chrome will not offer an install without a PNG of at least 192 and one of at
    // least 512. This is the check that would have caught the manifest as it was
    // first written, which listed only an SVG and a 180px iOS icon.
    check(
      any.some((i) => {
        const p = diskPath(i.src);
        const size = p && existsSync(p) ? pngSize(p) : null;
        return size && Math.min(size.width, size.height) >= 192;
      }),
      'manifest has an installable PNG of at least 192px',
      `${any.length} "any" PNG icon(s) listed`,
    );
    check(big.length > 0, 'manifest has an installable PNG of at least 512px');
    check(maskable.length > 0, 'manifest offers a maskable icon for cropped launchers');
  }
}

// 3. The service worker, or an installed app never updates.
fileOk(`${base}sw.js`, 'service worker');
fileOk(`${base}registerSW.js`, 'service worker registration');

// 4. The privacy invariant. This repository holds the shop's state and the mirrored
//    MYOB exports in a sibling repository, and the artifact is what goes on the
//    internet — so a build that ever sweeps them up must fail here, not in review.
const files = walk(root);
const forbidden = files.filter(
  (p) =>
    /(^|\/)(state|exports)\//.test(p.slice(root.length)) ||
    /\.(xlsx|xls|csv)$/i.test(p) ||
    p.endsWith('state.json'),
);
check(
  forbidden.length === 0,
  'build output contains no shop data',
  forbidden.length ? forbidden.map((p) => p.slice(root.length + 1)).join(', ') : `${files.length} files, none of them data`,
);

for (const line of [...notes, ...failures]) console.error(line);
if (failures.length) {
  console.error(`check-build: ${failures.length} problem(s) with ${root} at base ${base}`);
  process.exit(1);
}
console.error(`check-build: ${notes.length} checks passed for ${root} at base ${base}`);
