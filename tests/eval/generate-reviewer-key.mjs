import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function arg(name) { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1] ?? null; }
function inside(path) {
  const rel = relative(repoRoot, resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel));
}

async function main() {
  const privatePath = arg('--private-key');
  const publicPath = arg('--public-key');
  if (!privatePath || !publicPath) throw new Error('Usage: node generate-reviewer-key.mjs --private-key <external-private.pem> --public-key <external-public.pem>');
  if (inside(privatePath) || inside(publicPath) || resolve(privatePath) === resolve(publicPath)) throw new Error('Reviewer keys must be separate files stored outside the repository.');
  const pair = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  await mkdir(dirname(resolve(privatePath)), { recursive: true, mode: 0o700 });
  await mkdir(dirname(resolve(publicPath)), { recursive: true, mode: 0o700 });
  await writeFile(resolve(privatePath), pair.privateKey, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try { await writeFile(resolve(publicPath), pair.publicKey, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { await import('node:fs/promises').then(fs => fs.unlink(resolve(privatePath)).catch(() => {})); throw error; }
  console.log('Reviewer Ed25519 key pair created outside the repository. Keep the private key with the independent reviewer.');
}

main().catch(error => { console.error(`Reviewer key generation failed: ${error.message}`); process.exitCode = 1; });
