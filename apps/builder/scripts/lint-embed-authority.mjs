#!/usr/bin/env node
/*
 * lint-embed-authority: no fORM- embed code reads the user's DMS credentials (SEC-DESIGN 1.9 rule 2, T-DMSINT-53).
 *
 * Over every code file under `apps/builder/src/embed/**` (or `--root <dir>`), it fails when a file
 *
 *   cookie        reads `document.cookie` (also `document['cookie']`, `window.document.cookie`, `{ cookie } = document`) or uses `cookieStore`
 *   localStorage  mentions `localStorage` (bare, or on `window`, `globalThis`, `self`, `top`, `parent`, or by `x['localStorage']`)
 *   indexedDB     mentions `indexedDB`
 *   sessionStorage mentions `sessionStorage`, outside `session/handoff.ts` (the one file that may: `fp.lv`, `fp.resume`)
 *   legacy-reach  reaches `legacy/**` any other way than a dynamic `import()` inside
 *                 `if (import.meta.env.VITE_FP_LEGACY_DESCRIPTOR === '1') { ... }` (a static import would put the cookie reader
 *                 into the default bundle)
 *
 * `legacy/**` (the M2 build's `#fp=` parser and cookie reader) is exempt from `cookie` and `localStorage` only: it still may not
 * touch `indexedDB` or `sessionStorage`. Test files (`*.test.*`, `*.spec.*`) and `__fixtures__` folders under the root are not
 * shipped and are skipped. The check parses the TypeScript syntax tree, so words in comments and strings do not count.
 *
 *   node scripts/lint-embed-authority.mjs [--root <dir>]      exit 0 clean, 1 violations (listed on stderr), 2 usage
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '../src/embed');

const CODE = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const GLOBALS = new Set(['window', 'globalThis', 'self', 'top', 'parent', 'frames']);
const STORAGE = new Set(['localStorage', 'sessionStorage', 'indexedDB']);
const HANDOFF = 'session/handoff.ts';
const GUARD = 'VITE_FP_LEGACY_DESCRIPTOR';

/** @typedef {{ file: string, line: number, column: number, rule: string, message: string }} Violation */

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__fixtures__') continue;
      out.push(...walk(full));
    } else if (CODE.test(entry.name) && !TEST.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const posix = (p) => p.split(path.sep).join('/');

/** The module `spec` as a path relative to the embed root, or null when it points outside it. */
function resolveInside(spec, fromFile, root) {
  let target;
  if (spec.startsWith('@/embed/')) target = path.join(root, spec.slice('@/embed/'.length));
  else if (spec.startsWith('.')) target = path.resolve(path.dirname(fromFile), spec);
  else return null;
  const rel = posix(path.relative(root, target));
  return rel.startsWith('..') ? null : rel;
}

const intoLegacy = (rel) => rel !== null && (rel === 'legacy' || rel.startsWith('legacy/'));

/** The operands of an `a && b && c` chain (parentheses looked through). */
function conjuncts(expr) {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return [...conjuncts(expr.left), ...conjuncts(expr.right)];
  return [expr];
}

const isFlagTest = (c) =>
  ts.isBinaryExpression(c) &&
  c.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
  c.left.getText() === `import.meta.env.${GUARD}` &&
  ts.isStringLiteral(c.right) &&
  c.right.text === '1';

/** Is `node` inside the then-branch of `if (import.meta.env.VITE_FP_LEGACY_DESCRIPTOR === '1' [&& ...])`? */
function underFlagGuard(node) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) && parent.thenStatement === child && conjuncts(parent.expression).some(isFlagTest)) return true;
  }
  return false;
}

/**
 * @param {string} file absolute path
 * @param {string} root absolute embed root
 * @returns {Violation[]}
 */
export function lintFile(file, root) {
  const rel = posix(path.relative(root, file));
  const legacy = intoLegacy(rel);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  /** @type {Violation[]} */
  const found = [];
  const add = (node, rule, message) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({ file: rel, line: line + 1, column: character + 1, rule, message });
  };

  const storage = (node, name) => {
    if (name === 'indexedDB') return add(node, 'indexedDB', 'fORM- embed code never uses indexedDB');
    if (name === 'sessionStorage' && rel !== HANDOFF) return add(node, 'sessionStorage', `sessionStorage is only for ${HANDOFF} (fp.lv, fp.resume)`);
    if (name === 'sessionStorage') return;
    if (name === 'localStorage' && !legacy) add(node, 'localStorage', 'fORM- embed code never reads localStorage (the DMS token is not ours to read)');
  };
  const cookie = (node, what) => {
    if (!legacy) add(node, 'cookie', `fORM- embed code never reads ${what}`);
  };
  /** `document`, `window.document`, `globalThis.document`, ... */
  const isDocument = (expr) => (ts.isIdentifier(expr) && expr.text === 'document') || (ts.isPropertyAccessExpression(expr) && expr.name.text === 'document' && ts.isIdentifier(expr.expression) && GLOBALS.has(expr.expression.text));

  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (name === 'cookie' && isDocument(node.expression)) cookie(node, 'document.cookie');
      if (STORAGE.has(name) && ts.isIdentifier(node.expression) && GLOBALS.has(node.expression.text)) storage(node.name, name);
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const name = node.argumentExpression.text;
      if (name === 'cookie' && isDocument(node.expression)) cookie(node, "document['cookie']");
      if (STORAGE.has(name)) storage(node, name);
    } else if (ts.isIdentifier(node)) {
      const p = node.parent;
      // A name in a declaration or a member position is not a reference to the global.
      const isMemberName =
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        (ts.isPropertyAssignment(p) && p.name === node) ||
        ((ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p)) && p.name === node) ||
        (ts.isBindingElement(p) && p.propertyName === node) ||
        (ts.isQualifiedName(p) && p.right === node);
      if (!isMemberName) {
        if (STORAGE.has(node.text)) storage(node, node.text);
        if (node.text === 'cookieStore') cookie(node, 'cookieStore');
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer && isDocument(node.initializer) && ts.isObjectBindingPattern(node.name)) {
      // const { cookie } = document
      for (const el of node.name.elements) {
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key) && key.text === 'cookie') cookie(el, 'document.cookie');
      }
    }

    // Reaching the legacy modules: only a guarded dynamic import. (Type-only imports are erased and carry no code.)
    if (!legacy) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly;
        if (!typeOnly && intoLegacy(resolveInside(node.moduleSpecifier.text, file, root))) {
          add(node, 'legacy-reach', `static import of ${node.moduleSpecifier.text}: legacy modules are reached only by a dynamic import() inside if (import.meta.env.${GUARD} === '1')`);
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg) && intoLegacy(resolveInside(arg.text, file, root)) && !underFlagGuard(node)) {
          add(node, 'legacy-reach', `dynamic import of ${arg.text} outside if (import.meta.env.${GUARD} === '1')`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** @param {string} [root] @returns {Violation[]} */
export function lintEmbedAuthority(root = DEFAULT_ROOT) {
  const abs = path.resolve(root);
  return walk(abs)
    .sort()
    .flatMap((file) => lintFile(file, abs));
}

function main(argv) {
  let root = DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) root = path.resolve(argv[++i]);
    else {
      process.stderr.write('usage: node scripts/lint-embed-authority.mjs [--root <dir>]\n');
      return 2;
    }
  }
  const violations = lintEmbedAuthority(root);
  if (violations.length === 0) {
    process.stdout.write(`lint-embed-authority: ok (${walk(root).length} files under ${path.relative(process.cwd(), root) || '.'})\n`);
    return 0;
  }
  for (const v of violations) process.stderr.write(`${v.file}:${v.line}:${v.column}  ${v.rule}  ${v.message}\n`);
  process.stderr.write(`lint-embed-authority: ${violations.length} violation(s)\n`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
