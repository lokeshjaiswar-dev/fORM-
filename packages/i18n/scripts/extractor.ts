import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parseMessage } from '../src/icu.ts';
import { NAMESPACES, isNamespace, type Namespace } from '../src/messages.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const CATALOG_DIR = fileURLToPath(new URL('../locales/en-IN/', import.meta.url));

export interface ExtractedMessage {
  namespace: Namespace;
  key: string;
  message: string;
  location: string;
}

const SOURCE_FILE = /\.(ts|tsx)$/;
const SKIPPED_FILE = /\.(test|spec)\.tsx?$|\.d\.ts$/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_FILE.test(entry.name) && !SKIPPED_FILE.test(entry.name)) out.push(full);
  }
}

/** Every non-test `.ts`/`.tsx` file under `apps/<name>/src` and `packages/<name>/src`. */
export function sourceFiles(root: string = REPO_ROOT): string[] {
  const files: string[] = [];
  for (const group of ['apps', 'packages']) {
    const groupDir = path.join(root, group);
    let names: string[];
    try {
      names = readdirSync(groupDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const src = path.join(groupDir, name, 'src');
      try {
        if (statSync(src).isDirectory()) walk(src, files);
      } catch {
        continue;
      }
    }
  }
  return files.sort();
}

function literalText(node: ts.Node | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
}

const DEFINE_MESSAGES = 'defineMessages';

/** Local names bound to `defineMessages` by `import { defineMessages as dm } from '…'`. */
function importedAliases(source: ts.SourceFile): Set<string> {
  const names = new Set([DEFINE_MESSAGES]);
  for (const statement of source.statements) {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === DEFINE_MESSAGES) names.add(element.name.text);
    }
  }
  return names;
}

/** True for `defineMessages(…)`, an imported alias `dm(…)` and a member call `i18n.defineMessages(…)`. */
function isDefineMessagesCall(node: ts.CallExpression, aliases: ReadonlySet<string>): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return aliases.has(callee.text);
  return ts.isPropertyAccessExpression(callee) && callee.name.text === DEFINE_MESSAGES;
}

/** A reference that is not a call, e.g. `const dm = defineMessages`, which would hide messages from extraction. */
function isIndirectReference(node: ts.Identifier, aliases: ReadonlySet<string>): boolean {
  const parent = node.parent;
  const named = ts.isPropertyAccessExpression(parent) && parent.name === node ? DEFINE_MESSAGES === node.text : aliases.has(node.text);
  if (!named) return false;
  const reference = ts.isPropertyAccessExpression(parent) && parent.name === node ? parent : node;
  const holder = reference.parent;
  if (ts.isCallExpression(holder) && holder.expression === reference) return false;
  return !(
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isFunctionDeclaration(parent) ||
    (ts.isPropertyAccessExpression(parent) && parent.expression === node)
  );
}

/**
 * Reads `defineMessages('<namespace>', { key: 'message' })` calls, including imported aliases and
 * member calls; anything non-literal, and any other use of `defineMessages`, is an error.
 */
export function extractFromSource(fileName: string, text: string): { messages: ExtractedMessage[]; errors: string[] } {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const aliases = importedAliases(source);
  const messages: ExtractedMessage[] = [];
  const errors: string[] = [];
  const where = (node: ts.Node) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${fileName}:${line + 1}:${character + 1}`;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isIndirectReference(node, aliases)) {
      errors.push(`${where(node)}: call ${node.text} directly so its messages can be extracted`);
    }
    if (ts.isCallExpression(node) && isDefineMessagesCall(node, aliases)) {
      const [nsArg, objArg] = node.arguments;
      const namespace = literalText(nsArg);
      if (namespace === undefined || !isNamespace(namespace)) {
        errors.push(`${where(node)}: the namespace must be one of ${NAMESPACES.join(', ')} as a string literal`);
      } else if (!objArg || !ts.isObjectLiteralExpression(objArg)) {
        errors.push(`${where(node)}: messages must be an object literal`);
      } else {
        for (const property of objArg.properties) {
          const key =
            ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
              ? property.name.text
              : undefined;
          const message = ts.isPropertyAssignment(property) ? literalText(property.initializer) : undefined;
          if (key === undefined || message === undefined) {
            errors.push(`${where(property)}: each message must be \`key: 'literal'\``);
            continue;
          }
          messages.push({ namespace, key, message, location: where(property) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { messages, errors };
}

export type ExtractedCatalogs = Record<Namespace, Record<string, string>>;

export function buildCatalogs(messages: ExtractedMessage[]): { catalogs: ExtractedCatalogs; errors: string[] } {
  const errors: string[] = [];
  const seen = new Map<string, ExtractedMessage>();
  for (const entry of messages) {
    const id = `${entry.namespace}:${entry.key}`;
    const previous = seen.get(id);
    if (previous) {
      if (previous.message !== entry.message) {
        errors.push(`${entry.location}: ${id} is already defined differently at ${previous.location}`);
      }
      continue;
    }
    try {
      parseMessage(entry.message);
    } catch (error) {
      errors.push(`${entry.location}: ${id} is not valid ICU MessageFormat: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    seen.set(id, entry);
  }
  const catalogs = Object.fromEntries(NAMESPACES.map((ns) => [ns, {}])) as ExtractedCatalogs;
  const sorted = [...seen.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const entry of sorted) catalogs[entry.namespace][entry.key] = entry.message;
  return { catalogs, errors };
}

export function renderCatalog(catalog: Record<string, string>): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

export interface ExtractResult {
  errors: string[];
  /** Catalogue files whose content differs from the extraction (written unless `check`). */
  stale: string[];
}

export function extract(options: { root?: string; catalogDir?: string; check?: boolean } = {}): ExtractResult {
  const catalogDir = options.catalogDir ?? CATALOG_DIR;
  const messages: ExtractedMessage[] = [];
  const errors: string[] = [];
  const root = options.root ?? REPO_ROOT;
  for (const file of sourceFiles(root)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('defineMessages')) continue;
    const result = extractFromSource(path.relative(root, file).split(path.sep).join('/'), text);
    messages.push(...result.messages);
    errors.push(...result.errors);
  }
  const built = buildCatalogs(messages);
  errors.push(...built.errors);
  const stale: string[] = [];
  if (errors.length) return { errors, stale };
  for (const namespace of NAMESPACES) {
    const file = path.join(catalogDir, `${namespace}.json`);
    const next = renderCatalog(built.catalogs[namespace]);
    let current: string | undefined;
    try {
      current = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      current = undefined;
    }
    if (current === next) continue;
    stale.push(file);
    if (!options.check) writeFileSync(file, next);
  }
  return { errors, stale };
}
