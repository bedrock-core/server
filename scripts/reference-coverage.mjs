import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const sdk = fileURLToPath(new URL('../node_modules/@minecraft/server/', import.meta.url));
const metadata = JSON.parse(await readFile(path.join(sdk, 'package.json'), 'utf8'));
const entry = path.join(sdk, metadata.types ?? 'index.d.ts');
const program = ts.createProgram([entry], { noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ESNext, types: [] });
const checker = program.getTypeChecker();
const source = program.getSourceFile(entry);
const module = source && checker.getSymbolAtLocation(source);

if (!module) { throw new Error('Minecraft SDK declarations have no module exports'); }

const supported = new Map([
  ['Entity', 'World entity ID'], ['Player', 'World entity ID with player validation'],
  ['Dimension', 'Dimension ID'], ['Block', 'Dimension ID and block coordinates'],
  ['Container', 'Captured native inventory lookup'], ['ContainerSlot', 'Captured native inventory lookup and slot index'],
]);
const componentOwner = (type) => {
  const name = type.getSymbol()?.name;

  if (name === 'EntityComponent' || name === 'BlockComponent') { return name; }

  return type.getBaseTypes?.()?.map(componentOwner).find(Boolean);
};
const exports = checker.getExportsOfModule(module).map(symbol => ({ name: symbol.name, symbol: symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol }));
const classes = exports.filter(entry => entry.symbol.flags & ts.SymbolFlags.Class).map(({ name, symbol }) => {
  let status = 'unsupported';
  let rule = 'No native reference adapter or value codec';
  const component = componentOwner(checker.getDeclaredTypeOfSymbol(symbol));

  if (supported.has(name)) {
    status = 'reference';
    rule = supported.get(name);
  } else if (component) {
    status = 'reference';
    rule = component === 'EntityComponent' ? 'Owning entity ID and component ID' : 'Owning block location and component ID';
  } else if (name === 'BlockPermutation') {
    status = 'value';
    rule = 'Native block type and complete block states';
  } else if (name === 'ItemStack') {
    status = 'conditional-value';
    rule = 'Stacking-equivalent snapshots only; non-stackable, dynamic-property and unverifiable hidden-data items reject';
  } else if (name.endsWith('Type') || name.startsWith('Scoreboard')) {
    rule = 'Needs a verified registry/owner lookup adapter';
  }

  return { name, status, rule };
}).sort((left, right) => left.name.localeCompare(right.name));

process.stdout.write(JSON.stringify({ package: metadata.name, version: metadata.version, scope: 'exported native class instances',
  supported: classes.filter(item => item.status === 'reference').length, values: classes.filter(item => item.status === 'value' || item.status === 'conditional-value').length, classes }, null, 2) + '\n');
