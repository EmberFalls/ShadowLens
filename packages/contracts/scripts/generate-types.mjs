import { compileFromFile } from 'json-schema-to-typescript';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaDir = join(root, 'schemas');
const outputDir = join(root, 'src', 'generated');
const schemas = (await readdir(schemaDir)).filter(name => name.endsWith('.schema.json')).sort();
const generated = [];
const checkOnly = process.argv.includes('--check');
let changed = false;

for (const name of schemas) {
  const schemaPath = join(schemaDir, name);
  const typeName = basename(name, '.schema.json').split(/[-_]/).map(part => part[0].toUpperCase() + part.slice(1)).join('') + 'V2';
  const output = await compileFromFile(schemaPath, {
    bannerComment: `/* Generated from schemas/${name}; do not edit. */`,
    declareExternallyReferenced: true,
    enableConstEnums: false,
    style: { singleQuote: true },
    unknownAny: false,
    additionalProperties: false,
    unreachableDefinitions: true,
    $refOptions: { resolve: { http: { timeout: 1000 } } },
    type: typeName,
  });
  const outName = name.replace('.schema.json', '.ts');
  const outputPath = join(outputDir, outName);
  if (checkOnly) {
    const existing = await readFile(outputPath, 'utf8').catch(() => '');
    if (existing !== output) { console.error(`Generated contract is stale: ${outName}`); changed = true; }
  } else await writeFile(outputPath, output, 'utf8');
  generated.push(outName);
}

const barrel = generated.map(name => `export type * from './${name.replace(/\.ts$/, '.js')}';`).join('\n') + '\n';
const barrelPath = join(outputDir, 'index.ts');
if (checkOnly) {
  const existing = await readFile(barrelPath, 'utf8').catch(() => '');
  if (existing !== barrel) { console.error('Generated contract barrel is stale: index.ts'); changed = true; }
  if (changed) process.exitCode = 1;
  else console.log(`Verified ${generated.length} generated TypeScript contract modules are current.`);
} else {
  await writeFile(barrelPath, barrel, 'utf8');
  console.log(`Generated ${generated.length} TypeScript contract modules.`);
}
