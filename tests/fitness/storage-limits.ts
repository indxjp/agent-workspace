import ts from 'typescript';

const MiB = 1024 * 1024;

/** The one place each storage size limit is defined (the storage design, §04 "Size limits"). */
export const STORAGE_LIMITS = [
  { name: 'MAX_UPLOAD_BYTES', owner: 'packages/contracts/src/files.ts', bytes: 64 * MiB },
  {
    name: 'SIGNED_UPLOAD_HARD_MAX_BYTES',
    owner: 'packages/contracts/src/files.ts',
    bytes: 5 * 1024 * MiB,
  },
  { name: 'RUN_FILES_MAX_BYTES', owner: 'packages/runtime/src/transfer.ts', bytes: 128 * MiB },
  {
    name: 'SESSION_STATE_BLOB_MAX_BYTES',
    owner: 'packages/engine/src/session-state.ts',
    bytes: 32 * MiB,
  },
  {
    name: 'MAX_SKILL_REQUEST_BODY_BYTES',
    owner: 'packages/contracts/src/skills.ts',
    bytes: 16 * MiB,
  },
  {
    name: 'SURFACE_ATTACHMENT_MAX_BYTES',
    owner: 'packages/contracts/src/attachment-limits.ts',
    bytes: 10 * MiB,
  },
  {
    name: 'SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES',
    owner: 'packages/contracts/src/surfaces.ts',
    bytes: 50 * MiB,
  },
] as const;

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const SCOPE = [
  /^apps\/web\/server\/(?:files|skills|sessions|compose|runs|surfaces)\//u,
  /^apps\/runner\/src\//u,
  /^packages\/(?:runtime|contracts|engine|sdk|aw)\/src\//u,
  /^packages\/core\/src\/storage\//u,
];

/** Non-test (`.test`, `.acceptance`, `.contract`), non-declaration `.ts` in the storage scope. */
export function inStorageScope(path: string): boolean {
  return (
    path.endsWith('.ts') &&
    !/\.(?:test|acceptance|contract)\.ts$/u.test(path) &&
    !path.endsWith('.d.ts') &&
    SCOPE.some((pattern) => pattern.test(path))
  );
}

function fold(node: ts.Expression): number | null {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return fold(node.expression);
  }
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''));
  if (!ts.isBinaryExpression(node)) return null;
  const left = fold(node.left);
  const right = fold(node.right);
  if (left === null || right === null) return null;
  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.AsteriskToken:
      return left * right;
    case ts.SyntaxKind.PlusToken:
      return left + right;
    case ts.SyntaxKind.MinusToken:
      return left - right;
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return left ** right;
    case ts.SyntaxKind.LessThanLessThanToken:
      return left * 2 ** right;
    default:
      return null;
  }
}

interface Constant {
  readonly name: string;
  readonly value: number;
  readonly exported: boolean;
}

// ponytail: only literal arithmetic is folded; a constant written in terms of another identifier
// (`10 * MIB`), a default parameter or an object property is not seen. Resolve identifiers if a
// copy ever hides that way.
function numericConstants({ path, text }: SourceFile): Constant[] {
  const found: Constant[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && node.declarationList.flags & ts.NodeFlags.Const) {
      const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      for (const decl of node.declarationList.declarations) {
        const value = decl.initializer === undefined ? null : fold(decl.initializer);
        if (ts.isIdentifier(decl.name) && value !== null) {
          found.push({ name: decl.name.text, value, exported });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  return found;
}

/**
 * Constants in scope whose value equals a limit's bytes outside that limit's owner file.
 * Returns sorted, unique `path::NAME` keys.
 */
export function findLimitCopies(files: readonly SourceFile[]): string[] {
  const hits = new Set<string>();
  for (const file of files.filter(({ path }) => inStorageScope(path))) {
    for (const { name, value } of numericConstants(file)) {
      if (STORAGE_LIMITS.some((l) => l.bytes === value && l.owner !== file.path)) {
        hits.add(`${file.path}::${name}`);
      }
    }
  }
  return [...hits].sort();
}

/** `owner::NAME` for each limit whose owner file does not export that name with that value. */
export function findMissingOwners(files: readonly SourceFile[]): string[] {
  return STORAGE_LIMITS.filter((limit) => {
    const file = files.find(({ path }) => path === limit.owner);
    return !(
      file !== undefined &&
      numericConstants(file).some(
        (c) => c.exported && c.name === limit.name && c.value === limit.bytes,
      )
    );
  })
    .map((limit) => `${limit.owner}::${limit.name}`)
    .sort();
}
