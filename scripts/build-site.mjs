// Builds the GitHub Pages site into dist-site/:
//   site/*.html  → wrapped in site/_layout.html
//   PRIVACY.md   → privacy.html (single source of truth for the privacy policy)
// Usage: node scripts/build-site.mjs
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { marked } from 'marked';

const OUT = 'dist-site';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const layout = readFileSync('site/_layout.html', 'utf8');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function render({ title, description, page, content }) {
  return layout
    .replaceAll('{{title}}', esc(title))
    .replaceAll('{{description}}', esc(description))
    .replaceAll('{{version}}', esc(pkg.version))
    .replace(/\{\{current:(\w+)\}\}/g, (_, p) => (p === page ? 'aria-current="page"' : ''))
    .replace('{{content}}', content);
}

function meta(src, key) {
  const m = src.match(new RegExp(`<!--\\s*${key}:\\s*(.*?)\\s*-->`));
  if (!m) throw new Error(`missing <!-- ${key}: … --> header`);
  return m[1];
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Hand-written pages.
for (const file of readdirSync('site').filter((f) => f.endsWith('.html') && !f.startsWith('_'))) {
  const src = readFileSync(`site/${file}`, 'utf8');
  const content = src.replace(/<!--\s*(title|description|page):.*?-->\n?/g, '');
  writeFileSync(`${OUT}/${file}`, render({ title: meta(src, 'title'), description: meta(src, 'description'), page: meta(src, 'page'), content }));
}

// Privacy policy, rendered from PRIVACY.md.
const md = readFileSync('PRIVACY.md', 'utf8');
const [, mdTitle = 'Privacy policy'] = md.match(/^#\s+(.+)$/m) ?? [];
const body = marked.parse(md.replace(/^#\s+.+$/m, ''), { gfm: true });
writeFileSync(`${OUT}/privacy.html`, render({
  title: `${mdTitle.replace(/^Narada\s+/i, 'Narada ')}`,
  description: 'Narada collects nothing. What stays on your device, what travels directly between your own browsers, and which third parties help them connect.',
  page: 'privacy',
  content: `<div class="hero single"><div>
<p class="bubble">Narayan Narayan! Narada never gossips about your data.</p>
<h1>${esc(mdTitle)}</h1></div></div>
<article class="prose panel">${body}</article>`,
}));

// Static assets.
cpSync('site/style.css', `${OUT}/style.css`);
cpSync('src/assets', `${OUT}/assets`, { recursive: true });
cpSync('src/icons', `${OUT}/icons`, { recursive: true });
cpSync('docs/screenshots', `${OUT}/screenshots`, { recursive: true });
mkdirSync(`${OUT}/fonts`, { recursive: true });
for (const [name, files] of Object.entries({
  bangers: ['bangers-latin-400-normal.woff2'],
  'comic-neue': ['comic-neue-latin-400-normal.woff2', 'comic-neue-latin-700-normal.woff2'],
})) {
  for (const f of files) cpSync(`node_modules/@fontsource/${name}/files/${f}`, `${OUT}/fonts/${f}`);
  cpSync(`node_modules/@fontsource/${name}/LICENSE`, `${OUT}/fonts/LICENSE-${name}.txt`);
}
writeFileSync(`${OUT}/.nojekyll`, '');
console.log(`site built → ${OUT}/ (${readdirSync(OUT).filter((f) => f.endsWith('.html')).join(', ')})`);
