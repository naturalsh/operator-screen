// Validate every scenario's data files against schemas/*.schema.json.
// Usage: npm run validate
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const check = {
  caller: ajv.compile(read('schemas/caller_report.schema.json')),
  street: ajv.compile(read('schemas/street_access.schema.json')),
  fire: ajv.compile(read('schemas/fire_front.schema.json')),
};
const GEOMETRY = {
  street: ['LineString', 'MultiLineString'],
  fire: ['Polygon', 'MultiPolygon'],
};

let failures = 0;
function report(file, id, messages) {
  failures += 1;
  if (failures <= 20) console.error(`  ✗ ${file} ${id}: ${messages.join('; ')}`);
}

function validateRecords(file, kind, records) {
  const ids = new Set();
  for (const [i, rec] of records.entries()) {
    const props = kind === 'caller' ? rec : rec.properties;
    const id = props?.id ?? `#${i}`;
    if (!check[kind](props)) {
      report(file, id, check[kind].errors.map((e) => `${e.instancePath || '/'} ${e.message}`));
    }
    if (kind !== 'caller' && !GEOMETRY[kind].includes(rec.geometry?.type)) {
      report(file, id, [`geometry must be ${GEOMETRY[kind].join(' or ')}, got ${rec.geometry?.type}`]);
    }
    if (ids.has(id)) report(file, id, ['duplicate id']);
    ids.add(id);
  }
  return records.length;
}

for (const s of read('public/scenarios/index.json').scenarios) {
  console.log(`scenario ${s.id}`);
  const base = 'public/scenarios/';
  const files = [
    ['fire', s.files.fire_front, (d) => d.features],
    ['street', s.files.street_access, (d) => d.features],
    ['caller', s.files.caller_reports, (d) => d.records],
  ];
  for (const [kind, path, pick] of files) {
    const data = read(base + path);
    const n = validateRecords(path, kind, pick(data));
    const tag = data.metadata?.synthetic === true ? 'SYNTHETIC' : 'real';
    console.log(`  ${path}: ${n} records (${tag})`);
  }
}

if (failures) {
  console.error(`${failures} problem(s) found`);
  process.exit(1);
}
console.log('all data files match their schemas');
