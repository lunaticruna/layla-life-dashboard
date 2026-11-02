import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { validateInstallManifest } from '../scripts/manifest.mjs';

test('packaging rejects names that can collapse to an empty ASCII installation path', () => {
  for (const title of ['', '   ', '生活手记', '🌿', '../', '---']) assert.throws(() => validateInstallManifest({ title }));
});
test('release metadata uses a nonempty portable install title and Chinese description', async () => {
  const metadata = JSON.parse(await fs.readFile(new URL('../public/app.json', import.meta.url), 'utf8'));
  const result = validateInstallManifest(metadata);
  assert.equal(result.portableName, 'layla-life-dashboard');
  assert.match(metadata.description, /中文角色生活看板/);
  assert.equal(metadata.iconUri, 'icon.png');
});
