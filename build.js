/**
 * QUEEN'S TUG — Build (no toolchain, no dependencies)
 *
 * Produces dist/queens-tug.html: one self-contained file with the stylesheet,
 * every module and the key art inlined. The source of truth stays in src/ —
 * this script only concatenates, so the bundled game and the GitHub Pages game
 * can never drift apart.
 *
 *   node build.js
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

/** Module load order, resolved by hand — the graph is small and acyclic. */
const MODULE_ORDER = [
  'src/config.js',
  'src/rng.js',
  'src/engine.js',
  'src/playerView.js',
  'src/ai.js',
  'src/sound.js',
  'src/host.js',
  'src/multiplayer.js',
  'src/ui.js',
];

/**
 * Strip ESM syntax so the modules can be concatenated into one classic script.
 * Every module shares a single scope, so exported names simply become locals.
 * Duplicate local declarations are impossible here because the modules use
 * distinct top-level names — the build asserts that below.
 */
function stripModuleSyntax(code) {
  return code
    // import { a, b } from './x.js';  /  import x from './x.js';  /  import './x.js';
    .replace(/^\s*import\s+[^;]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '')
    // export { a, b };  and  export { a as b } from '...';
    .replace(/^\s*export\s*\{[^}]*\}\s*(from\s*['"][^'"]+['"])?;?\s*$/gm, '')
    // export const / export function / export class / export default
    .replace(/^\s*export\s+default\s+/gm, 'const __default__ = ')
    .replace(/^(\s*)export\s+(const|let|var|function|class|async)\b/gm, '$1$2');
}

function collectTopLevelNames(code, file, seen) {
  const re = /^(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(code))) {
    const name = m[1];
    if (seen.has(name)) {
      throw new Error(
        `Name collision building the bundle: "${name}" is declared in both ` +
          `${seen.get(name)} and ${file}. Rename one of them.`
      );
    }
    seen.set(name, file);
  }
}

const seen = new Map();
const bundled = MODULE_ORDER.map((file) => {
  const stripped = stripModuleSyntax(read(file));
  collectTopLevelNames(stripped, file, seen);
  return `/* ===== ${file} ===== */\n${stripped.trim()}\n`;
}).join('\n');

/* ---- assets ---- */

const css = read('styles.css');
const logo = readFileSync(join(root, 'assets/logo.webp')).toString('base64');
const logoDataUri = `data:image/webp;base64,${logo}`;

/* ---- assemble ---- */

let html = read('index.html');

/**
 * NOTE: every replacement below uses a FUNCTION replacer, not a string.
 * A string replacement treats `$$`, `$&` and `$1` as substitution patterns,
 * which silently corrupts the bundle — `const $$ = ...` becomes `const $ = ...`
 * and the file stops parsing. A function replacer is taken literally.
 */
html = html
  .replace('<link rel="stylesheet" href="./styles.css">', () => `<style>\n${css}\n</style>`)
  .replace('./assets/logo.webp', () => logoDataUri)
  .replace(
    '<script type="module" src="./src/ui.js"></script>',
    () => `<script>\n(function(){\n"use strict";\n${bundled}\n})();\n</script>`
  );

if (html.includes('type="module"')) {
  throw new Error('Bundle still references a module script — the inline step did not fire.');
}

/* ---- verify before writing ---- */

const scriptMatch = html.match(/<script>\n\(function\(\)\{\n"use strict";\n([\s\S]*?)\n\}\)\(\);\n<\/script>/);
if (!scriptMatch) throw new Error('Could not locate the inlined script in the output.');
const inlined = scriptMatch[1];

// Catch the $$ / $& replacement-pattern corruption class specifically.
for (const marker of ['const $$ =', 'const $ =']) {
  if (!inlined.includes(marker)) {
    throw new Error(`Bundle is missing "${marker}" — a replacement pattern probably mangled it.`);
  }
}
if (/import\s|export\s+(const|function|class|default)/.test(inlined)) {
  throw new Error('ESM syntax survived into the bundle.');
}
try {
  new Function(inlined);
} catch (err) {
  throw new Error(`Bundled script does not parse: ${err.message}`);
}
if (!html.includes('data:image/webp;base64,')) throw new Error('Key art was not inlined.');

const outDir = join(root, 'dist');
if (!existsSync(outDir)) mkdirSync(outDir);
const outPath = join(outDir, 'queens-tug.html');
writeFileSync(outPath, html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`Built dist/queens-tug.html — ${kb} KB, ${MODULE_ORDER.length} modules inlined, zero dependencies.`);
