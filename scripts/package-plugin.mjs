import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dest = path.join(root, 'dist/compose-visual-bridge');
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(path.join(root, 'plugin'), dest, { recursive: true });
await cp(path.join(root, 'storage.mjs'), path.join(dest, 'storage.mjs'));
await mkdir(path.join(dest,'public'),{recursive:true});
await cp(path.join(root,'public/modifier-layout.mjs'),path.join(dest,'public/modifier-layout.mjs'));
await cp(path.join(root,'public/typography.mjs'),path.join(dest,'public/typography.mjs'));
for (const name of ['live.mjs', 'previews.mjs', 'adapter.mjs', 'docs/previews.md', 'project.mjs', 'transfer-result.mjs', 'scene.mjs', 'compose.mjs', 'scripts/compose.mjs', 'scripts/compare-png.mjs', 'docs/live-app.md', 'docs/browser-compose.md', 'baseline.mjs', 'source-map.mjs', 'native.mjs', 'server.mjs', 'AGENT.md', 'integrations/android', 'docs/protocol.md', 'docs/native-ui.md', 'public/index.html', 'public/lab.html', 'public/native.css', 'public/style.css', 'public/fonts', 'THIRD_PARTY_NOTICES.md', 'public/model.mjs', 'public/compose-capabilities.mjs', 'public/report.mjs', 'public/build', 'scripts/bridge.mjs', 'scripts/plugin.mjs', 'scripts/native.mjs', 'scripts/native-project.mjs', 'scripts/native-device.mjs', 'examples/server-screen.json']) {
  await mkdir(path.dirname(path.join(dest, name)), { recursive: true });
  await cp(path.join(root, name), path.join(dest, name), { recursive: true });
}
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
await writeFile(path.join(dest, 'package.json'), JSON.stringify({ name: 'compose-visual-bridge', version, type: 'module', engines: { node: '>=20' } }, null, 2) + '\n');
console.log(`Плагин собран: ${dest}`);

const marketplace = JSON.parse(await readFile(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'));
marketplace.plugins[0].source.path = './compose-visual-bridge';
await mkdir(path.join(root, 'dist/.agents/plugins'), { recursive: true });
await writeFile(path.join(root, 'dist/.agents/plugins/marketplace.json'), JSON.stringify(marketplace, null, 2) + '\n');
const claudeManifest = path.join(dest, '.claude-plugin/plugin.json');
const claudePlugin = JSON.parse(await readFile(claudeManifest, 'utf8'));
claudePlugin.version = version;
await writeFile(claudeManifest, JSON.stringify(claudePlugin, null, 2) + '\n');
await mkdir(path.join(root, 'dist/.claude-plugin'), { recursive: true });
await writeFile(path.join(root, 'dist/.claude-plugin/marketplace.json'), JSON.stringify({
  name: 'compose-visual-bridge-local',
  owner: { name: 'arttvad9r' },
  description: 'Локальный каталог плагина Compose Visual Bridge',
  plugins: [{ name: 'compose-visual-bridge', source: './compose-visual-bridge', description: claudePlugin.description, version, category: 'development' }],
}, null, 2) + '\n');
const archive = path.join(root, 'dist', `compose-visual-bridge-${version}.tgz`);
execFileSync('tar', ['-czf', archive, '-C', path.join(root, 'dist'), '.agents', '.claude-plugin', 'compose-visual-bridge']);
console.log(`Архив для установки: ${archive}`);
