import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

/** Exported types that are not wire data, with where their checking happens instead. */
const NO_TWIN: Record<string, string> = {
  Brand: 'utility; every branded id has its own twin',
  BlockBase: 'generic; checked per type through BLOCK_SCHEMAS',
  FieldBase: 'generic; checked per type through FIELD_BLOCK_SCHEMAS',
  FieldBlockOf: 'generic; twin is FIELD_BLOCK_SCHEMAS[T]',
  PlainBlockOf: 'generic; twin is PLAIN_BLOCK_SCHEMAS[T]',
  BlockOf: 'generic; twin is BLOCK_SCHEMAS[T]',
  AnswerOf: 'generic; twin is ANSWER_VALUE_SCHEMAS[T]',
  SchemaLike: 'registry contract (methods)',
  PaletteEntry: 'registry contract (generic over BlockConfigMap[T])',
  FieldDefinition: 'registry contract (methods)',
  FieldRegistry: 'registry contract (methods)',
  MigrationContext: 'injected services (methods)',
  MigrationStep: 'migration contract (methods)',
  AnswerCodec: 'codec contract (methods)',
  EvalState: 'evaluator result (ReadonlySet, nextPage method)',
  ValidateDefinition: 'function signature',
  Compile: 'function signature',
  ResolveForPublish: 'function signature',
  Evaluate: 'function signature',
  ProjectForRuntime: 'function signature',
  Migrate: 'function signature',
  Instantiate: 'function signature',
  InsertSnippet: 'function signature',
  LockFingerprint: 'function signature',
  SanitizeForTemplate: 'function signature',
  DiffTemplate: 'function signature',
};

const fileUrl = import.meta.url;
const root = decodeURIComponent(fileUrl.slice(0, fileUrl.lastIndexOf('/test/')).replace(/^file:\/\//, '')).replace(/^\/([A-Za-z]:)/, '$1');
const file = (rel: string) => `${root}/${rel}`;

interface ModuleExports { types: string[]; values: Set<string> }
let v2: ModuleExports;
let v1: ModuleExports;
let api: ModuleExports;
let asserted: Set<string>;

function exportsOf(program: ts.Program, path: string): ModuleExports {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(path);
  const symbol = source && checker.getSymbolAtLocation(source);
  if (!symbol) throw new Error(`cannot read exports of ${path}`);
  const types: string[] = [];
  const values = new Set<string>();
  for (const exported of checker.getExportsOfModule(symbol)) {
    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    if (target.flags & (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface)) types.push(exported.name);
    if (target.flags & ts.SymbolFlags.Value) values.add(exported.name);
  }
  return { types, values };
}

/**
 * `NS.T` for every `expectTypeOf<z.infer<typeof NS.TSchema>>()[.branded].toEqualTypeOf<NS.T>()` in the source:
 * the schema and the type must name the same export, and negated or partial checks do not count.
 */
function assertedTwins(source: string): Set<string> {
  const sf = ts.createSourceFile('twins.test-d.ts', source, ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'toEqualTypeOf') {
      let subject = node.expression.expression;
      if (ts.isPropertyAccessExpression(subject) && subject.name.text === 'branded') subject = subject.expression;
      const expected = node.typeArguments?.[0];
      const actual = ts.isCallExpression(subject) && ts.isIdentifier(subject.expression) && subject.expression.text === 'expectTypeOf' ? subject.typeArguments?.[0] : undefined;
      const query = actual && ts.isTypeReferenceNode(actual) && actual.typeName.getText(sf) === 'z.infer' ? actual.typeArguments?.[0] : undefined;
      if (query && ts.isTypeQueryNode(query) && ts.isQualifiedName(query.exprName) && expected && ts.isTypeReferenceNode(expected) && ts.isQualifiedName(expected.typeName)) {
        const ns = query.exprName.left.getText(sf);
        const type = expected.typeName.right.text;
        if (expected.typeName.left.getText(sf) === ns && query.exprName.right.text === `${type}Schema`) out.add(`${ns}.${type}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

beforeAll(() => {
  const entries = [file('src/index.ts'), file('src/v2/index.ts'), file('src/v1.ts')];
  const program = ts.createProgram(entries, {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    types: [],
  });
  api = exportsOf(program, entries[0] ?? '');
  v2 = exportsOf(program, entries[1] ?? '');
  v1 = exportsOf(program, entries[2] ?? '');
  asserted = assertedTwins(ts.sys.readFile(file('test/twins.test-d.ts')) ?? '');
}, 120_000);

describe('zod twin coverage', () => {
  it('reads the contract', () => {
    expect(v2.types.length).toBeGreaterThan(300);
    expect(v1.types.length).toBeGreaterThan(4);
    expect(asserted.size).toBeGreaterThan(300);
  });

  it('every exported v2 type has a twin `<Type>Schema` or a documented reason not to', () => {
    const gaps = v2.types.filter((t) => !(t in NO_TWIN) && !api.values.has(`${t}Schema`));
    expect(gaps).toEqual([]);
  });

  it('every twin has an equality assertion in twins.test-d.ts', () => {
    const unasserted = v2.types.filter((t) => !(t in NO_TWIN) && !asserted.has(`S.${t}`));
    expect(unasserted).toEqual([]);
  });

  it('every exported v1 type has an asserted twin', () => {
    const gaps = v1.types.filter((t) => !v1.values.has(`${t}Schema`) || !asserted.has(`V1.${t}`));
    expect(gaps).toEqual([]);
  });

  it('only counts full equality assertions', () => {
    const probe = assertedTwins([
      '// expectTypeOf<z.infer<typeof S.ACommentSchema>>().toEqualTypeOf<S.AComment>();',
      'expectTypeOf<z.infer<typeof S.NegatedSchema>>().not.toEqualTypeOf<S.Negated>();',
      'expectTypeOf<z.infer<typeof S.OtherSchema>>().toEqualTypeOf<S.Mismatch>();',
      'expectTypeOf<z.infer<typeof S.PartialSchema>>().toMatchTypeOf<S.Partial>();',
      'expectTypeOf<z.infer<typeof S.GoodSchema>>().branded.toEqualTypeOf<S.Good>();',
    ].join('\n'));
    expect([...probe]).toEqual(['S.Good']);
  });

  it('the exemption list has no stale entries', () => {
    expect(Object.keys(NO_TWIN).filter((t) => !v2.types.includes(t))).toEqual([]);
  });
});
