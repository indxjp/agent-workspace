import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  compareWithDisk,
  renderReferencePages,
} from '../../scripts/docs/generate-sdk-reference.mjs';
import { familyClientNames, rootClientMethods } from '../../scripts/docs/lib/families.mjs';

// `renderReferencePages` runs the real generator over this repository's own `packages/contracts`,
// `packages/sdk` and `packages/aw` source — three TypeScript programs plus one probe program — so
// it is computed once here and every test below reuses the same `Map`.
const repoRoot = path.resolve(import.meta.dirname, '../..');
let pages: Map<string, string>;
const temporaryRoots: string[] = [];

async function writePages(source: ReadonlyMap<string, string>, outDir: string): Promise<void> {
  for (const [relativePath, content] of source) {
    const diskPath = path.join(outDir, ...relativePath.split('/'));
    await mkdir(path.dirname(diskPath), { recursive: true });
    await writeFile(diskPath, content, 'utf8');
  }
}

async function freshOutDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-workspace-docs-check-'));
  temporaryRoots.push(root);
  return root;
}

beforeAll(async () => {
  pages = await renderReferencePages(repoRoot);
}, 60_000);

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('renderReferencePages', () => {
  it('renders every reference page the site declares', () => {
    expect(pages.size).toBeGreaterThan(30);
    expect(pages.has('sdk/client.mdx')).toBe(true);
    expect(pages.has('contracts/index.mdx')).toBe(true);
    expect(pages.has('contracts/runs.mdx')).toBe(true);
    expect(pages.has('cli/commands.mdx')).toBe(true);
    for (const content of pages.values()) {
      expect(content.endsWith('\n')).toBe(true);
      expect(content.endsWith('\n\n')).toBe(false);
      expect(content.includes('\r')).toBe(false);
    }
  });

  // `@indx-workspace/sdk/define` is a public subpath (issue #445), so it has a reference page of
  // its own, rendered from the barrel through the same per-export renderer as the events page.
  it('renders the define subpath page with its entry points', () => {
    const define = pages.get('sdk/define.mdx');

    expect(define).toBeDefined();
    expect(define).toContain('title: "Define"');
    expect(define).toContain('## defineAgent');
    expect(define).toContain('## toAgentVersionBody');
    expect(define).toContain('## DefinitionError');
  });

  // `@indx-workspace/sdk/project` is a public subpath (issue #446), the one reader and renderer of
  // agent-workspace.yaml and the project files, so it has a reference page of its own too.
  it('renders the project subpath page with its entry points', () => {
    const project = pages.get('sdk/project.mdx');

    expect(project).toBeDefined();
    expect(project).toContain('title: "Project"');
    expect(project).toContain('## parseProjectFile');
    expect(project).toContain('## renderProjectFiles');
    expect(project).toContain('## renderProjectShell');
    expect(project).toContain('## ProjectFileError');
  });

  // The client page used to render a hard-coded list of four error classes, so a new public class
  // (`InvalidArgumentError`, issue #488) shipped without a reference section. Every class
  // `errors.ts` exports must have one, in declaration order.
  it('renders a section for every error class the SDK exports, in declaration order', async () => {
    const client = pages.get('sdk/client.mdx');
    const errorsSource = await readFile(
      path.join(repoRoot, 'packages', 'sdk', 'src', 'errors.ts'),
      'utf8',
    );
    const declared = [...errorsSource.matchAll(/^export (?:abstract )?class (\w+)/gmu)].map(
      (match) => match[1],
    );

    expect(declared).toContain('InvalidArgumentError');
    expect(client).toBeDefined();
    const rendered = [...(client ?? '').matchAll(/^## (\w+Error)$/gmu)].map((match) => match[1]);
    expect(rendered).toEqual(declared);
  });

  // ADR-0054 relies on the generator being deterministic (sorted exports, no timestamps) so that
  // `docs:check` cannot flake: a second, independent render must reproduce the first byte for byte.
  it('renders byte-identical output, in the same order, on a second render', async () => {
    const second = await renderReferencePages(repoRoot);

    expect([...second.keys()]).toEqual([...pages.keys()]);
    for (const [relativePath, content] of second) {
      expect(content).toBe(pages.get(relativePath));
    }
  }, 60_000);
});

describe('compareWithDisk', () => {
  it('exits clean (ok: true, no issues) when the directory matches the rendering', async () => {
    const outDir = await freshOutDir();
    await writePages(pages, outDir);

    const result = await compareWithDisk(pages, outDir);

    expect(result).toEqual({ ok: true, issues: [] });
  });

  it('reports a stale page by name, and only that page, when a committed page differs', async () => {
    const outDir = await freshOutDir();
    await writePages(pages, outDir);
    const staleFile = path.join(outDir, 'sdk', 'client.mdx');
    await writeFile(staleFile, 'this is not what the generator would produce\n', 'utf8');

    const result = await compareWithDisk(pages, outDir);

    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain('sdk/client.mdx');
    expect(result.issues[0]).toContain('pnpm docs:generate');
  });

  it('reports a page the generator produces but the directory is missing', async () => {
    const outDir = await freshOutDir();
    await writePages(pages, outDir);
    await rm(path.join(outDir, 'cli', 'commands.mdx'));

    const result = await compareWithDisk(pages, outDir);

    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (issue) => issue.includes('missing') && issue.includes('cli/commands.mdx'),
      ),
    ).toBe(true);
  });

  it('reports a page on disk that the generator no longer produces', async () => {
    const outDir = await freshOutDir();
    await writePages(pages, outDir);
    await writeFile(
      path.join(outDir, 'sdk', 'no-longer-generated.mdx'),
      'stale leftover\n',
      'utf8',
    );

    const result = await compareWithDisk(pages, outDir);

    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (issue) => issue.includes('extra') && issue.includes('sdk/no-longer-generated.mdx'),
      ),
    ).toBe(true);
  });
});

/**
 * A program over one in-memory `AgentWorkspaceClient` declaration, plus its checker. The file is
 * never written to disk — the host answers for that one name and delegates everything else, the
 * same shape `scripts/docs/lib/ts-project.mjs` uses for its probe files. `noLib` keeps it fast:
 * these cases read member kinds, and no assertion below depends on a resolved library type.
 */
function syntheticClientProgram(source: string): {
  readonly checker: ts.TypeChecker;
  readonly file: ts.SourceFile;
} {
  const fileName = path.join(repoRoot, 'synthetic-agent-workspace-client.ts');
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2023, noLib: true };
  const host = ts.createCompilerHost(options, true);
  const realGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersionOrOptions, onError, shouldCreateNewFile) =>
    name === fileName
      ? ts.createSourceFile(name, source, ts.ScriptTarget.ES2023, true)
      : realGetSourceFile(name, languageVersionOrOptions, onError, shouldCreateNewFile);
  const realFileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === fileName || realFileExists(name);
  const realReadFile = host.readFile.bind(host);
  host.readFile = (name) => (name === fileName ? source : realReadFile(name));

  const program = ts.createProgram({ rootNames: [fileName], options, host });
  const file = program.getSourceFile(fileName);
  if (file === undefined) throw new Error('the synthetic AgentWorkspaceClient was not loaded');
  return { checker: program.getTypeChecker(), file };
}

/**
 * The partition `scripts/docs/lib/families.mjs` draws over `AgentWorkspaceClient`'s members: a
 * property is a family and gets its own page, a method signature is an operation and is rendered
 * on `sdk/client.mdx` by `rootClientMethods`, and anything else is refused.
 *
 * That refusal cannot be reached through `renderReferencePages`, which is why it is driven
 * directly here. Today's interface declares nothing but properties and one method, so every gate
 * in the repository — `pnpm docs:check` included — passes whether the `throw` stands or is
 * replaced by `return []`. A silently dropped member is exactly the fail-open the `throw` was
 * added to close, so it needs a case of its own rather than a branch nothing executes.
 */
describe('familyClientNames and rootClientMethods', () => {
  it('refuses a member kind it cannot classify, naming the kind', () => {
    // An index signature is neither a property signature nor a method signature.
    const { checker, file } = syntheticClientProgram(
      'export interface AgentWorkspaceClient {\n  [key: string]: unknown;\n}\n',
    );

    expect(() => familyClientNames(checker, file)).toThrow(/IndexSignature/u);
    expect(() => familyClientNames(checker, file)).toThrow(/cannot classify/u);
  });

  it('reads a property as a family and leaves a method signature to rootClientMethods', () => {
    const { checker, file } = syntheticClientProgram(
      'export interface RunsClient {\n  readonly kind: string;\n}\n' +
        'export interface AgentWorkspaceClient {\n' +
        '  readonly runs: RunsClient;\n' +
        '  me(): void;\n' +
        '}\n',
    );

    expect(familyClientNames(checker, file)).toEqual([
      { property: 'runs', className: 'RunsClient' },
    ]);
    expect(rootClientMethods(file).map((method) => method.name.getText())).toEqual(['me']);
  });

  it("returns the real client's one method signature from packages/sdk/src/index.ts", async () => {
    const indexPath = path.join(repoRoot, 'packages', 'sdk', 'src', 'index.ts');
    const indexFile = ts.createSourceFile(
      indexPath,
      await readFile(indexPath, 'utf8'),
      ts.ScriptTarget.ES2023,
      true,
    );

    expect(rootClientMethods(indexFile).map((method) => method.name.getText())).toEqual(['me']);
  });
});
