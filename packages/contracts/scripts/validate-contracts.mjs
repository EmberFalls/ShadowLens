import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaFiles = readdirSync(join(root, 'schemas')).filter(name => name.endsWith('.schema.json'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const schemas = schemaFiles.map(name => JSON.parse(readFileSync(join(root, 'schemas', name), 'utf8')));
for (const schema of schemas) ajv.addSchema(schema);
for (const name of schemaFiles) {
  const schema = schemas.find(item => item.$id.endsWith(`/${name}`));
  if (schema) ajv.compile(schema);
}
const fixtureCounts = { valid: 0, invalid: 0 };
for (const kind of ['valid', 'invalid']) for (const file of readdirSync(join(root, 'fixtures', kind))) {
  const value = JSON.parse(readFileSync(join(root, 'fixtures', kind, file), 'utf8'));
  const validate = ajv.getSchema('https://shadowshield.local/contracts/v2/event.schema.json');
  const valid = Boolean(validate?.(value));
  if ((kind === 'valid') !== valid) throw new Error(`${kind} fixture classification failed: ${file}; ${JSON.stringify(validate?.errors ?? [])}`);
  fixtureCounts[kind]++;
}
if (fixtureCounts.valid < 3 || fixtureCounts.invalid < 3) throw new Error('SH-001 requires at least three valid and three invalid event fixtures');
const validateDomainProjection = ajv.getSchema('https://shadowshield.local/contracts/v2/domain.schema.json');
const deviceFixtureCounts = { valid: 0, invalid: 0 };
for (const kind of ['valid', 'invalid']) for (const file of readdirSync(join(root, 'fixtures', 'devices', kind))) {
  const value = JSON.parse(readFileSync(join(root, 'fixtures', 'devices', kind, file), 'utf8'));
  const valid = Boolean(validateDomainProjection(value));
  if ((kind === 'valid') !== valid) throw new Error(`${kind} device fixture classification failed: ${file}; ${JSON.stringify(validateDomainProjection.errors ?? [])}`);
  deviceFixtureCounts[kind]++;
}
const schemaFixtureCounts = {};
for (const schemaName of ['analysis', 'analytics', 'device', 'domain', 'event-batch', 'policy']) {
  const validate = ajv.getSchema(`https://shadowshield.local/contracts/v2/${schemaName}.schema.json`);
  const counts = { valid: 0, invalid: 0 };
  for (const kind of ['valid', 'invalid']) for (const file of readdirSync(join(root, 'fixtures', 'schemas', schemaName, kind))) {
    const value = JSON.parse(readFileSync(join(root, 'fixtures', 'schemas', schemaName, kind, file), 'utf8'));
    const valid = Boolean(validate?.(value));
    if ((kind === 'valid') !== valid) throw new Error(`${kind} ${schemaName} schema fixture classification failed: ${file}; ${JSON.stringify(validate?.errors ?? [])}`);
    counts[kind]++;
  }
  schemaFixtureCounts[schemaName] = counts;
}
const domainSchema = schemas.find(schema => schema.$id.endsWith('/domain.schema.json'));
const registry = JSON.parse(readFileSync(join(root, 'domain-registry.json'), 'utf8'));
const siteIds = domainSchema?.$defs?.site?.enum ?? [];
const supportStatuses = ['GUARDED', 'BEST_EFFORT', 'UNSUPPORTED'];
if (registry.contractVersion !== 'v2' || !Array.isArray(registry.sites) || registry.sites.length !== siteIds.length) throw new Error('domain registry must enumerate every v2 site exactly once');
const seenSites = new Set();
const seenHosts = new Set();
for (const site of registry.sites) {
  if (!site || Object.keys(site).sort().join(',') !== 'hosts,siteId,supportStatus' || !siteIds.includes(site.siteId) || seenSites.has(site.siteId) || !supportStatuses.includes(site.supportStatus) || !Array.isArray(site.hosts) || site.hosts.length === 0) throw new Error('invalid domain registry entry');
  seenSites.add(site.siteId);
  for (const host of site.hosts) {
    if (typeof host !== 'string' || host !== host.toLowerCase() || !/^(?:localhost|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/.test(host) || seenHosts.has(host)) throw new Error(`invalid or duplicate exact host in domain registry: ${host}`);
    seenHosts.add(host);
  }
}
if (!seenSites.has('SANDBOX') || !registry.sites.find(site => site.siteId === 'SANDBOX').hosts.includes('localhost')) throw new Error('sandbox host must be explicitly registered');
const openapi = readFileSync(join(root, 'openapi.yaml'), 'utf8');
if (!openapi.includes('http://127.0.0.1:8787/api/v1') || !openapi.includes('/devices:') || !openapi.includes('#/$defs/DeviceListV2')) throw new Error('OpenAPI must freeze the /api/v1 device response contract');
const sandboxProtocol = readFileSync(join(root, 'sandbox-protocol.md'), 'utf8');
for (const required of ['#shadow-composer', '#shadow-send', '#shadow-received', 'shadowshield:submit-request', 'shadowshield:receipt', 'protocol:"v2"']) if (!sandboxProtocol.includes(required)) throw new Error(`sandbox protocol missing required selector/message: ${required}`);
const eventSchema = JSON.parse(readFileSync(join(root, 'schemas', 'event.schema.json'), 'utf8'));
if (!Array.isArray(eventSchema.oneOf) || eventSchema.oneOf.length !== 3) throw new Error('event schema must define exactly three variants');
const requiredForbidden = ['rawText', 'url', 'fileName', 'matchedValue', 'promptHash', 'snippet'];
for (const forbidden of requiredForbidden) if (JSON.stringify(eventSchema).includes(`"${forbidden}"`)) throw new Error(`forbidden field found in event schema: ${forbidden}`);
console.log(`Validated ${schemaFiles.length} Draft 2020-12 schemas; ${fixtureCounts.valid}/${fixtureCounts.invalid} valid/invalid events, ${deviceFixtureCounts.valid}/${deviceFixtureCounts.invalid} device projections, and ${Object.values(schemaFixtureCounts).reduce((sum, counts) => sum + counts.valid, 0)}/${Object.values(schemaFixtureCounts).reduce((sum, counts) => sum + counts.invalid, 0)} valid/invalid schema fixtures; forbidden event fields absent.`);
