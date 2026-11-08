import { build, transform } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { validateInstallManifest } from './manifest.mjs';
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'public/app.json'), 'utf8'));
const installMetadata = validateInstallManifest(manifest);
await fs.mkdir(out, { recursive: true });
const js = await build({ entryPoints: [path.join(root, 'src/main.js')], bundle: true, format: 'iife', target: 'es2020', write: false, minify: true, legalComments: 'eof' });
const css = await transform(await fs.readFile(path.join(root, 'src/styles.css'), 'utf8'), { loader: 'css', minify: true, target: 'safari16' });
const template = await fs.readFile(path.join(root, 'index.template.html'), 'utf8');
// Function replacers prevent ECMA-262 $& special pattern expansion in minified JS/CSS
const html = template
  .replace('<!-- STYLES -->', () => `<style>${css.code}</style>`)
  .replace('<!-- SCRIPT -->', () => `<script>${js.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`);

// Build-time validation: ensure placeholders are replaced and JS parses cleanly
if (html.includes('<!-- SCRIPT -->') || html.includes('<!-- STYLES -->')) {
  throw new Error('Build error: unreplaced template comment detected in dist/index.html');
}
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  throw new Error('Build error: <script> tag missing in dist/index.html');
}
new vm.Script(scriptMatch[1]);
await fs.writeFile(path.join(out, 'index.html'), html);
const task = await build({ entryPoints: [path.join(root, 'src/task-entry.js')], bundle: true, format: 'iife', globalName: 'LifeTask', target: 'es2020', write: false, minify: false });
await fs.writeFile(path.join(out, 'task.js'), `${task.outputFiles[0].text}\nLifeTask.run();\n`);
for (const filename of ['app.json', 'icon.png']) await fs.copyFile(path.join(root, 'public', filename), path.join(out, filename));
for (const [src, dst] of [['README.md', 'README_中文.md'], ['CHANGELOG.md', 'CHANGELOG.md'], ['UAT_FREEZE.md', 'UAT_FREEZE.md'], ['VALIDATION.md', 'VALIDATION.md'], ['UPGRADE_0.2.1_中文.md', 'UPGRADE_0.2.1_中文.md'], ['EXPORT_FORMAT_SPEC.md', 'EXPORT_FORMAT_SPEC.md'], ['THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.txt'], ['LICENSE', 'LICENSE']]) await fs.copyFile(path.join(root, src), path.join(out, dst));
console.log(JSON.stringify({ directory: out, htmlBytes: Buffer.byteLength(html), sdk: '7.6.2', taskCompletion: 'LifeTask.run()', installMetadata }));
