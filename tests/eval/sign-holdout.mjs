import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonl } from './eval.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}
function isInside(path, directory) {
  const rel = relative(resolve(directory), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel));
}
function canonicalJson(value) {
  const sort = input => Array.isArray(input) ? input.map(sort)
    : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, sort(input[key])]))
      : input;
  return JSON.stringify(sort(value));
}

async function main() {
  const sealedDirectory = arg('--directory');
  const releaseSha = arg('--release-sha');
  const reviewerId = arg('--reviewer-id');
  const privateKeyPath = arg('--private-key');
  if (!sealedDirectory || !/^[0-9a-f]{40}$/i.test(releaseSha ?? '') || !reviewerId || reviewerId === 'PENDING' || !privateKeyPath) {
    throw new Error('Usage: node sign-holdout.mjs --directory <external-dir> --release-sha <40-char-git-sha> --reviewer-id <independent-id> --private-key <external-ed25519-private-key.pem>');
  }
  if (isInside(sealedDirectory, repoRoot) || isInside(privateKeyPath, repoRoot)) {
    throw new Error('The sealed corpus and reviewer private key must remain outside the repository.');
  }
  const directory = resolve(sealedDirectory);
  const raw = await readFile(resolve(directory, 'holdout.jsonl'), 'utf8');
  const records = parseJsonl(raw, 'holdout');
  const counts = Object.fromEntries(['SENSITIVE', 'BENIGN', 'AMBIGUOUS'].map(truth => [truth, records.filter(row => row.truth === truth).length]));
  const families = new Set(records.map(row => row.templateFamily));
  if (records.length < 30 || families.size < 10 || counts.SENSITIVE < 10 || counts.BENIGN < 10 || counts.AMBIGUOUS < 5
    || records.some(row => row.split !== 'holdout' || row.source !== 'independent_human')) {
    throw new Error('Holdout needs 30+ independently authored rows, 10+ families, at least 10 sensitive, 10 benign and 5 ambiguous rows.');
  }
  const privateKey = createPrivateKey(await readFile(privateKeyPath));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Reviewer private key must be Ed25519.');
  const publicKey = createPublicKey(privateKey);
  const reviewerKeyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const unsigned = {
    algorithm: 'Ed25519',
    releaseSha: releaseSha.toLowerCase(),
    reviewedAt: new Date().toISOString(),
    reviewerId,
    reviewerKeyId,
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
  const attestation = { ...unsigned, signature: sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64') };
  await writeFile(resolve(directory, 'holdout-attestation.json'), `${JSON.stringify(attestation, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(`Signed holdout attestation for release ${unsigned.releaseSha}.`);
  console.log(`Reviewer key fingerprint: ${reviewerKeyId}`);
  console.log(`Corpus SHA-256: ${unsigned.sha256}`);
}

main().catch(error => {
  console.error(`Holdout signing failed: ${error.message}`);
  process.exitCode = 1;
});
