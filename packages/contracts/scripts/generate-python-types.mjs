import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaDir = join(root, 'schemas');
const outputDir = join(root, 'python', 'shadowshield_contracts');
const checkOnly = process.argv.includes('--check');
const schemaFiles = (await readdir(schemaDir)).filter(file => file.endsWith('.schema.json')).sort();
const schemas = await Promise.all(schemaFiles.map(async file => ({ file, value: JSON.parse(await readFile(join(schemaDir, file), 'utf8')) })));
const byFile = new Map(schemas.map(item => [item.file, item]));
const byId = new Map(schemas.map(item => [item.value.$id, item]));
const rootTypes = new Map();
const outputs = new Map();

function pascal(value) {
  const pieces = String(value).replace(/([a-z0-9])([A-Z])/g, '$1 $2').match(/[A-Za-z0-9]+/g) ?? [];
  const result = pieces.map(piece => piece[0].toUpperCase() + piece.slice(1)).join('');
  return /^\d/.test(result) ? `T${result}` : result || 'GeneratedType';
}

function pythonModule(file) { return basename(file, '.schema.json').replace(/-/g, '_'); }

function resolveRef(ref, current) {
  const [filePart, fragment = ''] = ref.split('#');
  let target = current;
  if (filePart) {
    const candidate = byFile.get(basename(filePart));
    if (!candidate) throw new Error(`Cannot resolve schema reference ${ref}`);
    target = candidate;
  }
  const pieces = fragment.split('/').filter(Boolean).map(piece => piece.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!pieces.length) return { module: pythonModule(target.file), name: rootTypes.get(target.file), external: target.file !== current.file };
  let value = target.value;
  for (const piece of pieces) value = value?.[piece];
  if (!value) throw new Error(`Schema reference target is missing: ${ref}`);
  if (pieces[0] === '$defs' && pieces.length === 2) return { module: pythonModule(target.file), name: pascal(pieces[1]), external: target.file !== current.file };
  throw new Error(`Unsupported schema reference path: ${ref}`);
}

function pyLiteral(value) {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  return JSON.stringify(value);
}

function literal(values) { return `Literal[${values.map(pyLiteral).join(', ')}]`; }

function renderModule(current) {
  const rootName = rootTypes.get(current.file);
  const declarations = new Map();
  const externalImports = new Map();
  for (const [name, definition] of Object.entries(current.value.$defs ?? {})) declarations.set(pascal(name), definition);
  declarations.set(rootName, current.value);

  function annotation(schema, suggestedName) {
    if (schema.$ref) {
      const ref = resolveRef(schema.$ref, current);
      if (ref.external) {
        if (!externalImports.has(ref.module)) externalImports.set(ref.module, new Set());
        externalImports.get(ref.module).add(ref.name);
      }
      return JSON.stringify(ref.name);
    }
    if (schema.oneOf) return `Union[${schema.oneOf.map(item => annotation(item, suggestedName)).join(', ')}]`;
    if (schema.anyOf) return `Union[${schema.anyOf.map(item => annotation(item, suggestedName)).join(', ')}]`;
    if (schema.enum) return literal(schema.enum);
    if (Object.hasOwn(schema, 'const')) return literal([schema.const]);
    if (Array.isArray(schema.type)) return `Union[${schema.type.map(type => type === 'null' ? 'None' : scalarType(type)).join(', ')}]`;
    if (schema.type === 'object' || schema.properties) {
      if (schema.properties && Object.keys(schema.properties).length) {
        const name = pascal(suggestedName);
        if (!declarations.has(name)) declarations.set(name, schema);
        return JSON.stringify(name);
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const keyType = schema.propertyNames ? annotation(schema.propertyNames, `${suggestedName}Key`) : 'str';
        return `dict[${keyType}, ${annotation(schema.additionalProperties, `${suggestedName}Value`)}]`;
      }
      if (schema.additionalProperties === false) return 'dict[str, Any]';
      return 'dict[str, Any]';
    }
    if (schema.type === 'array') return `list[${annotation(schema.items ?? {}, `${suggestedName}Item`)}]`;
    return scalarType(schema.type);
  }

  function unionMember(schema, suggestedName) {
    if (!schema.$ref) return annotation(schema, suggestedName);
    const ref = resolveRef(schema.$ref, current);
    if (ref.external) {
      if (!externalImports.has(ref.module)) externalImports.set(ref.module, new Set());
      externalImports.get(ref.module).add(ref.name);
    }
    return ref.name;
  }

  function scalarType(type) {
    return ({ string: 'str', integer: 'int', number: 'float', boolean: 'bool', null: 'None' })[type] ?? 'Any';
  }

  let index = 0;
  while (index < declarations.size) {
    const [name, schema] = [...declarations.entries()][index++];
    if (schema.oneOf || schema.anyOf) {
      const alternatives = schema.oneOf ?? schema.anyOf;
      outputs.set(name, `${name}: TypeAlias = Union[${alternatives.map(item => unionMember(item, name)).join(', ')}]`);
    } else if (schema.enum || Object.hasOwn(schema, 'const')) {
      outputs.set(name, `${name}: TypeAlias = ${annotation(schema, name)}`);
    } else if (schema.type === 'object' || schema.properties) {
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const entries = Object.entries(properties).map(([key, value]) => {
        const type = annotation(value, `${name}${pascal(key)}`);
        const qualifier = required.has(key) ? 'Required' : 'NotRequired';
        return `    ${JSON.stringify(key)}: ${qualifier}[${type}],`;
      });
      outputs.set(name, `${name} = TypedDict(${JSON.stringify(name)}, {\n${entries.join('\n')}\n}, total=False)`);
    } else {
      outputs.set(name, `${name}: TypeAlias = ${annotation(schema, name)}`);
    }
  }

  const imports = [...externalImports].sort(([a], [b]) => a.localeCompare(b)).map(([module, names]) => `from .${module} import ${[...names].sort().join(', ')}`);
  const declarationsText = [...outputs.values()].join('\n\n');
  return [
    '"""Generated from JSON Schema; do not edit by hand."""',
    'from __future__ import annotations',
    'from typing import Any, Literal, NotRequired, Required, TypeAlias, TypedDict, Union',
    ...imports,
    '',
    declarationsText,
    '',
  ].join('\n');
}

for (const item of schemas) rootTypes.set(item.file, pascal(item.value.title ?? basename(item.file, '.schema.json')));

const generated = [];
for (const item of schemas) {
  outputs.clear();
  const filename = `${pythonModule(item.file)}.py`;
  generated.push([filename, renderModule(item)]);
}

const init = schemas.map(item => `from .${pythonModule(item.file)} import ${rootTypes.get(item.file)}`).join('\n') + '\n';
generated.push(['__init__.py', `${init}\n__all__ = [${schemas.map(item => JSON.stringify(rootTypes.get(item.file))).join(', ')}]\n`]);
generated.push(['py.typed', '']);

let stale = false;
await mkdir(outputDir, { recursive: true });
for (const [filename, content] of generated) {
  const path = join(outputDir, filename);
  if (checkOnly) {
    const existing = await readFile(path, 'utf8').catch(() => null);
    if (existing !== content) { console.error(`Generated Python contract is stale: ${filename}`); stale = true; }
  } else await writeFile(path, content, 'utf8');
}
if (stale) process.exitCode = 1;
else {
  const pythonScript = [
    'import ast, importlib, json, pathlib, pkgutil, sys, typing',
    'package_root=pathlib.Path(sys.argv[1])',
    'fixture_root=pathlib.Path(sys.argv[2])',
    '[ast.parse(path.read_text(encoding="utf-8"), filename=str(path)) for path in package_root.glob("*.py")]',
    'import shadowshield_contracts as package',
    'for module_info in pkgutil.iter_modules(package.__path__):',
    ' module=importlib.import_module(f"shadowshield_contracts.{module_info.name}")',
    ' for name, value in vars(module).items():',
    '  if typing.is_typeddict(value) and value.__module__ == module.__name__:',
    '   typing.get_type_hints(value, include_extras=True)',
    '   if not value.__required_keys__ and not value.__optional_keys__: raise TypeError(f"{module.__name__}.{name} has no typed fields")',
    'for path in fixture_root.rglob("*.json"): ',
    ' value=json.loads(path.read_text(encoding="utf-8"))',
    ' if json.loads(json.dumps(value, ensure_ascii=False)) != value: raise ValueError(f"fixture JSON round-trip failed: {path}")',
  ].join('\n');
  const python = spawnSync('python', ['-c', pythonScript, outputDir, join(root, 'fixtures')], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: join(root, 'python') } });
  if (python.status !== 0) throw new Error(`Python syntax validation failed: ${python.stderr || python.stdout}`);
  console.log(`${checkOnly ? 'Verified' : 'Generated'} ${schemas.length} Python DTO modules; imports, type hints and JSON fixture round-trips passed.`);
}
