// Prints the AMO submission metadata for a release: store/amo-metadata.json plus
// release notes that link to the GitHub release. Usage: node scripts/amo-metadata.mjs v1.2.3
import { readFileSync } from 'node:fs';

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) {
  console.error('usage: node scripts/amo-metadata.mjs vX.Y.Z');
  process.exit(1);
}
const meta = JSON.parse(readFileSync(new URL('../store/amo-metadata.json', import.meta.url), 'utf8'));
const repo = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY ?? 'dmdhrumilmistry/narada'}`;
meta.version = {
  ...meta.version,
  release_notes: { 'en-US': `Release ${tag}. Full changelog: ${repo}/releases/tag/${tag}` },
};
// Build instructions shown to AMO reviewers alongside the uploaded source archive.
meta.version.approval_notes = [
  'This add-on is bundled with esbuild. The attached source archive is the tagged commit.',
  'To reproduce dist/firefox: install Node.js 22, then run `npm ci && npm run build`.',
  'Third-party code: @noble/curves (BIP-340 signatures for Nostr). Fonts: Bangers and Comic Neue (SIL OFL).',
].join('\n');
process.stdout.write(JSON.stringify(meta, null, 2) + '\n');
