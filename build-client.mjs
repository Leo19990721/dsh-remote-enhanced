import { readFile, writeFile } from 'node:fs/promises';
const path = new URL('./native-client.js', import.meta.url);
let source = await readFile(new URL('./native-client.template.js', import.meta.url), 'utf8');
for (const [marker, filename] of [['/* STREAMS */', 'client-streams.js'], ['/* CARRIER */', 'client-carrier.js'], ['/* MODELS */', 'client-models.js'], ['/* RESIDENCY */', 'client-residency.js'], ['/* BROWSER */', 'client-browser.js'], ['/* RESOURCE_MENUS */', 'client-resource-menus.js'], ['/* RESOURCES */', 'client-resources.js'], ['/* HEALTH */', 'client-health.js']]) {
  if (!source.includes(marker)) throw new Error(`Client marker missing: ${marker}`);
  const module = (await readFile(new URL('./' + filename, import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replaceAll('export class ', 'class ').replaceAll('export async function ', 'async function ').replaceAll('export function ', 'function ');
  source = source.replace(marker, module);
}
const dictionaries = {};
for (const language of ['zh', 'en']) dictionaries[language] = JSON.parse(await readFile(new URL(`./locale/${language}.json`, import.meta.url), 'utf8')).ui;
if (!source.includes('/* DICTIONARIES */ {}')) throw new Error('Client dictionaries marker missing');
await writeFile(path, source.replace('/* DICTIONARIES */ {}', JSON.stringify(dictionaries)).replace(/[ \t]+$/gm, ''));
console.log('Built native independent-Session carrier.');
