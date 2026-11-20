import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import * as databaseModel from './db-model.js';
import * as database from './db/index.js';

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(sourceRoot, 'db-model.ts');

/**
 * The specifiers a module loads when it runs. A type-only declaration (`import type`, `export
 * type`) is erased; an `import { type A }` is not, because `verbatimModuleSyntax` keeps it as a
 * side-effect import, so it counts.
 */
function runtimeSpecifiers(file: string): readonly string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly === true) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) {
      if (statement.isTypeOnly) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    }
  }
  return specifiers;
}

/** Every module `db-model.ts` loads, transitively: source files and package specifiers. */
function runtimeClosure(): {
  readonly files: readonly string[];
  readonly packages: readonly string[];
} {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of runtimeSpecifiers(file)) {
      if (!specifier.startsWith('.')) {
        packages.add(specifier);
        continue;
      }
      pending.push(path.resolve(path.dirname(file), specifier.replace(/\.js$/u, '.ts')));
    }
  }
  return {
    files: [...files].map((file) => path.relative(sourceRoot, file).split(path.sep).join('/')),
    packages: [...packages],
  };
}

describe('@agent-workspace/core/db-model', () => {
  it('loads no package and none of the schema, the client or the repositories that query', () => {
    const closure = runtimeClosure();
    expect(closure.packages).toEqual([]);
    expect([...closure.files].sort()).toEqual([
      'db-model.ts',
      'db/limits.ts',
      'db/repositories/agent-versions-body.ts',
      'db/repositories/agent-versions-resolution.ts',
      'db/repositories/directory/local-runtime-key-name.ts',
      'db/repositories/project-archive.ts',
      'db/repositories/resource-catalogs-model.ts',
      'db/repositories/resource-catalogs-port.ts',
      'db/repositories/unknown-workspace.ts',
    ]);
  });

  it('re-exports the very values @agent-workspace/core/db exposes, and declares none', () => {
    const names = Object.keys(databaseModel);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(Reflect.get(database, name), name).toBe(Reflect.get(databaseModel, name));
    }
  });
});
