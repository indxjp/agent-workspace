import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { createGatewayApplication } from './index.js';
import { createRouter } from './router.js';
import type { RequestContext } from './types.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const SPEC_PATH = path.join(REPO_ROOT, 'docs/spec.md');
const TYPES_PATH = path.join(import.meta.dirname, 'types.ts');
const specText = readFileSync(SPEC_PATH, 'utf8');

type Member = { readonly optional: boolean; readonly type: string };

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

function section(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start === -1) throw new Error(`docs/spec.md has no heading ${JSON.stringify(heading)}.`);
  const after = lines.slice(start + 1);
  const end = after.findIndex((line) => /^#{1,6}\s/.test(line));
  return (end === -1 ? after : after.slice(0, end)).join('\n');
}

function fencedBlock(markdownSection: string, language: 'text' | 'ts'): string {
  const match = new RegExp('```' + language + '\\r?\\n([\\s\\S]*?)```').exec(markdownSection);
  if (match?.[1] === undefined) throw new Error(`Spec section has no ${language} fenced block.`);
  return match[1];
}

function normalizedType(node: ts.TypeNode, source: ts.SourceFile): string {
  return printer
    .printNode(ts.EmitHint.Unspecified, node, source)
    .replace(/\s+/g, ' ')
    .replace(/'/g, '"')
    .trim();
}

function declarationMembers(sourceText: string, name: string): ReadonlyMap<string, Member> {
  const source = ts.createSourceFile('declarations.ts', sourceText, ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(
    (statement) =>
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      statement.name.text === name,
  );
  if (declaration === undefined) throw new Error(`Declaration ${name} is missing.`);

  const members = ts.isInterfaceDeclaration(declaration)
    ? declaration.members
    : ts.isTypeAliasDeclaration(declaration) && ts.isTypeLiteralNode(declaration.type)
      ? declaration.type.members
      : undefined;
  if (members === undefined) throw new Error(`${name} is not an object-shaped declaration.`);

  const result = new Map<string, Member>();
  for (const member of members) {
    const memberName = member.name?.getText(source);
    if (memberName === undefined) throw new Error(`${name} contains an unnamed member.`);
    if (ts.isPropertySignature(member) && member.type !== undefined) {
      result.set(memberName, {
        optional: member.questionToken !== undefined,
        type: normalizedType(member.type, source),
      });
      continue;
    }
    if (ts.isMethodSignature(member)) {
      const parameters = member.parameters
        .map((parameter) => {
          const parameterName = parameter.name.getText(source);
          const optional = parameter.questionToken === undefined ? '' : '?';
          const type =
            parameter.type === undefined ? 'unknown' : normalizedType(parameter.type, source);
          return `${parameterName}${optional}: ${type}`;
        })
        .join(', ');
      const returnType = member.type === undefined ? 'void' : normalizedType(member.type, source);
      result.set(memberName, {
        optional: member.questionToken !== undefined,
        type: `(${parameters}): ${returnType}`,
      });
      continue;
    }
    throw new Error(`${name}.${memberName} is not a property or method signature.`);
  }
  return result;
}

function emittedDeclarations(): string {
  const result = ts.transpileDeclaration(readFileSync(TYPES_PATH, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    },
    fileName: TYPES_PATH,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new Error(
      errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
        .join('\n'),
    );
  }
  return result.outputText;
}

function specRoutes(): readonly { readonly method: string; readonly path: string }[] {
  return fencedBlock(section(specText, '# 9. Model Gateway'), 'text')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const match = /^(GET|POST)\s+(\/\S+)$/.exec(line.trim());
      if (match?.[1] === undefined || match[2] === undefined) {
        throw new Error(`Unparseable §9 route: ${JSON.stringify(line)}.`);
      }
      return { method: match[1], path: match[2] };
    });
}

const context: RequestContext = {
  providerId: 'anthropic',
  credential: 'test-only-provider-key',
  requestId: 'request-test',
  settings: {},
};

describe('gateway contract is derived from docs/spec.md', () => {
  it('registers exactly the §9 routes, in the order the specification prints them', () => {
    const application = createGatewayApplication({
      tokenSecret: 'spec-conformance-token-secret-0001',
      resolver: { resolve: () => Promise.resolve({ state: 'missing' }) },
    });
    expect(application.routes).toEqual(specRoutes());
  });

  it.each([
    ['# 10. Model Gateway Provider Architecture', 'ModelProvider'],
    ['# 12. Never Pretend Providers Are Fully Equivalent', 'ModelCapabilities'],
  ] as const)('emits %s / %s member-for-member', (heading, name) => {
    const fromSpec = declarationMembers(fencedBlock(section(specText, heading), 'ts'), name);
    const fromDeclaration = declarationMembers(emittedDeclarations(), name);
    expect([...fromDeclaration]).toEqual([...fromSpec]);
  });
});

describe('gateway refusals are positive', () => {
  it('returns its own 404 envelope for an unknown path', async () => {
    const response = await createRouter([]).fetch(new Request('http://gateway/not-a-route'));
    expect(response.status).toBe(404);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      type: 'error',
      error: { type: 'not_found_error' },
    });
    expect(JSON.stringify(body)).toContain('/not-a-route');
  });

  it('names the missing provider for a known provider route and never returns 200', async () => {
    const response = await createRouter([]).fetch(
      new Request('http://gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-test', messages: [] }),
      }),
      context,
    );
    expect(response.status).toBe(503);
    expect(response.status).not.toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      type: 'error',
      error: { type: 'provider_not_registered' },
      request_id: context.requestId,
    });
    expect(JSON.stringify(body)).toContain('anthropic');
  });
});
