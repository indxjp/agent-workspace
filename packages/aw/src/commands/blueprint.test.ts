import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { parseArguments } from '../args.js';
import type { LocalCommand } from '../command.js';
import type { CliIo } from '../io.js';
import { EXIT_CODE, outputMode, reportFailure, type ExitCode } from '../output.js';
import { runCli, tempDirectory } from '../testing.js';
import { AW_VERSION } from '../version.js';
import { sha512Integrity, type BlueprintFetch, type FetchedBlueprint } from './blueprint-fetch.js';
import { blueprintCommandsWith } from './blueprint.js';

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const PACKAGE = '@acme/helpdesk-blueprint';

// ---------------------------------------------------------------------------------------------
// In-memory blueprint packages: a ustar archive, gzipped, as `npm pack` writes one.

const encoder = new TextEncoder();

function header(name: string, size: number): Uint8Array {
  const block = new Uint8Array(512);
  const put = (offset: number, text: string): void => {
    block.set(encoder.encode(text), offset);
  };
  const octal = (value: number, width: number): string =>
    `${value.toString(8).padStart(width - 1, '0')}\0`;
  put(0, name);
  put(100, octal(0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(size, 12));
  put(136, octal(0, 12));
  put(148, '        ');
  put(156, '0');
  put(257, 'ustar\u000000');
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

function tarball(files: Readonly<Record<string, string>>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = encoder.encode(text);
    blocks.push(header(`package/${name}`, body.length));
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(blocks));
}

interface Version {
  readonly version: string;
  readonly appKit?: string;
  readonly parts: Readonly<Record<string, string>>;
  readonly migrations: Readonly<Record<string, string>>;
  readonly package?: string;
}

function kindOf(file: string): string {
  if (file.startsWith('resources/')) return 'resource';
  if (file.startsWith('app/')) return 'page';
  return 'test';
}

function release(version: Version): FetchedBlueprint {
  const manifest = {
    name: 'helpdesk',
    version: version.version,
    appKit: version.appKit ?? AW_VERSION,
    parts: Object.keys(version.parts).map((file) => ({ path: file, kind: kindOf(file) })),
    slots: { connectors: [{ slot: 'email', kind: 'mcp' }], secrets: [], agents: [] },
    migrations: Object.keys(version.migrations),
  };
  const name = version.package ?? PACKAGE;
  const bytes = tarball({
    'package.json': JSON.stringify({
      name,
      version: version.version,
      keywords: ['indx-workspace-blueprint'],
    }),
    'blueprint.json': JSON.stringify(manifest),
    ...version.parts,
    ...version.migrations,
  });
  return {
    package: name,
    version: version.version,
    integrity: sha512Integrity(bytes),
    tarball: bytes,
  };
}

const TICKET_V1 = "export default { name: 'ticket' };\n";
const PAGE_V1 = 'export default function Tickets() {\n  return null;\n}\n';
const CREATE_TICKETS = 'CREATE TABLE "{{appSchema}}"."tickets" ("id" uuid PRIMARY KEY);\n';

const V1: Version = {
  version: '1.0.0',
  parts: { 'resources/ticket.ts': TICKET_V1, 'app/tickets/page.tsx': PAGE_V1 },
  migrations: { 'migrations/0000_create_tickets.sql': CREATE_TICKETS },
};

const V2: Version = {
  version: '1.1.0',
  parts: {
    'resources/ticket.ts': "export default { name: 'ticket', sla: true };\n",
    'app/tickets/page.tsx': 'export default function Tickets() {\n  return "v2";\n}\n',
    'tests/ticket.test.ts': 'export {};\n',
  },
  migrations: {
    ...V1.migrations,
    'migrations/0001_add_sla.sql': 'ALTER TABLE "{{appSchema}}"."tickets" ADD COLUMN "sla" text;\n',
  },
};

const DESTRUCTIVE: Version = {
  ...V2,
  version: '1.2.0',
  migrations: {
    ...V1.migrations,
    'migrations/0001_drop_status.sql':
      'ALTER TABLE "{{appSchema}}"."tickets" DROP COLUMN "status";\n',
  },
};

/** A fetch over in-memory releases: `<package>@<version>`, or `@latest` for the newest. */
function registry(...versions: readonly Version[]): BlueprintFetch & { specs: string[] } {
  const specs: string[] = [];
  const fetch = (spec: string): Promise<FetchedBlueprint> => {
    specs.push(spec);
    const at = spec.lastIndexOf('@');
    const wanted = at > 0 ? spec.slice(at + 1) : 'latest';
    const found =
      wanted === 'latest' ? versions.at(-1) : versions.find((v) => v.version === wanted);
    if (found === undefined) return Promise.reject(new Error(`no ${spec}`));
    return Promise.resolve(release(found));
  };
  return Object.assign(fetch, { specs });
}

// ---------------------------------------------------------------------------------------------
// A generated app, with the app kit stubbed at aw's version.

const STUB_BIN = "process.stdout.write('-- stub\\n');\n";

async function generatedProject(): Promise<string> {
  const root = await tempDirectory();
  temporary.push(root);
  await writeFile(path.join(root, 'package.json'), '{\n  "name": "desk",\n  "private": true\n}\n');
  const kit = path.join(root, 'node_modules', '@indx-workspace', 'app');
  await mkdir(kit, { recursive: true });
  await writeFile(
    path.join(kit, 'package.json'),
    JSON.stringify({
      name: '@indx-workspace/app',
      version: AW_VERSION,
      bin: { 'aw-app': './b.js' },
    }),
  );
  await writeFile(path.join(kit, 'b.js'), STUB_BIN);
  const app = await runCli(['generate', 'app', 'desk'], { cwd: root, env: {} });
  expect(app.code).toBe(EXIT_CODE.ok);
  return root;
}

/** Every file under `root` with its text, `node_modules` aside. */
async function tree(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (relative === 'node_modules') continue;
    if (entry.isDirectory()) Object.assign(result, await tree(root, relative));
    else result[relative] = await readFile(path.join(root, relative), 'utf8');
  }
  return result;
}

interface Run {
  readonly code: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one `aw blueprint ...` line over the given fetch, as `main` would. */
async function aw(cwd: string, fetch: BlueprintFetch, argv: readonly string[]): Promise<Run> {
  const commands: readonly LocalCommand[] = blueprintCommandsWith(fetch);
  const args = parseArguments(argv);
  const target = commands.find((candidate) =>
    candidate.path.every((word, index) => args.positionals[index] === word),
  );
  if (target === undefined) throw new Error(`no command ${argv.join(' ')}`);
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdin: () => Promise.resolve(''),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: {},
    homeDir: cwd,
    fetch: () => Promise.reject(new Error('no network')),
    isTty: false,
    cwd,
  };
  try {
    await target.run({
      io,
      args,
      positionals: args.positionals.slice(target.path.length),
      mode: outputMode(args),
      signal: new AbortController().signal,
      readStdin: () => Promise.resolve(''),
      cwd,
    });
    return { code: EXIT_CODE.ok, stdout, stderr };
  } catch (error) {
    const code = reportFailure(io, error, false);
    return { code, stdout, stderr };
  }
}

async function generatedManifest(root: string): Promise<{
  entries: Record<string, { files: Record<string, string>; source?: unknown }>;
}> {
  return JSON.parse(await readFile(path.join(root, 'aw-generated.json'), 'utf8')) as {
    entries: Record<string, { files: Record<string, string>; source?: unknown }>;
  };
}

async function installed(fetch: BlueprintFetch): Promise<string> {
  const root = await generatedProject();
  const add = await aw(root, fetch, ['blueprint', 'add', `${PACKAGE}@1.0.0`, '--yes']);
  expect(add.stderr).toBe('');
  expect(add.code).toBe(EXIT_CODE.ok);
  return root;
}

describe('aw blueprint add', () => {
  it('shows the plan and exits 3 without --yes, writing nothing', async () => {
    const root = await generatedProject();
    const before = await tree(root);
    const run = await aw(root, registry(V1), ['blueprint', 'add', `${PACKAGE}@1.0.0`]);
    expect(run.code).toBe(EXIT_CODE.contract);
    expect(run.stdout).toContain(`would install blueprint:helpdesk from ${PACKAGE}@1.0.0`);
    expect(run.stdout).toContain('add       resources/ticket.ts');
    expect(run.stdout).toContain('add       db/migrations/0003_create_tickets.sql');
    expect(run.stdout).toContain(
      "edit      app.config.ts: import ticket from './resources/ticket.ts';",
    );
    expect(run.stdout).toContain('to bind   connector email');
    expect(await tree(root)).toEqual(before);
  });

  it('with --yes writes the parts, wires them and records the source and each sha256', async () => {
    const root = await installed(registry(V1));
    const files = await tree(root);
    expect(files['resources/ticket.ts']).toBe(TICKET_V1);
    expect(files['db/migrations/0003_create_tickets.sql']).toBe(
      'CREATE TABLE "app_desk"."tickets" ("id" uuid PRIMARY KEY);\n',
    );
    expect(files['app.config.ts']).toContain("import ticket from './resources/ticket.ts';");
    expect(files['db/migrations/meta/_journal.json']).toContain('"0003_create_tickets"');
    const entry = (await generatedManifest(root)).entries['blueprint:helpdesk'];
    expect(entry?.source).toEqual({
      package: PACKAGE,
      version: '1.0.0',
      integrity: release(V1).integrity,
    });
    expect(Object.keys(entry?.files ?? {})).toEqual([
      'app/tickets/page.tsx',
      'db/migrations/0003_create_tickets.sql',
      'resources/ticket.ts',
    ]);
    expect(entry?.files['resources/ticket.ts']).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('refuses an appKit the installed app kit does not satisfy, writing nothing', async () => {
    const root = await generatedProject();
    const before = await tree(root);
    const run = await aw(root, registry({ ...V1, appKit: '^99.0.0' }), [
      'blueprint',
      'add',
      PACKAGE,
      '--yes',
    ]);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(
      `appKit: needs @indx-workspace/app ^99.0.0; the app has ${AW_VERSION}`,
    );
    expect(await tree(root)).toEqual(before);
  });

  it('refuses a path collision, writing nothing', async () => {
    const root = await generatedProject();
    await mkdir(path.join(root, 'resources'), { recursive: true });
    await writeFile(path.join(root, 'resources', 'ticket.ts'), 'mine\n');
    const before = await tree(root);
    const run = await aw(root, registry(V1), ['blueprint', 'add', PACKAGE, '--yes']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('resources/ticket.ts: exists already');
    expect(await tree(root)).toEqual(before);
  });

  it('refuses a destructive migration by name, writing nothing', async () => {
    const root = await generatedProject();
    const before = await tree(root);
    const run = await aw(root, registry(DESTRUCTIVE), ['blueprint', 'add', PACKAGE, '--yes']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('migrations/0001_drop_status.sql: is not expand-only (DROP)');
    expect(await tree(root)).toEqual(before);
  });

  it('refuses a {{key}} placeholder in a part', async () => {
    const root = await generatedProject();
    const run = await aw(
      root,
      registry({
        ...V1,
        parts: { ...V1.parts, 'resources/ticket.ts': 'const x = "{{appSchema}}";\n' },
      }),
      ['blueprint', 'add', PACKAGE, '--yes'],
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('appSchema: is a placeholder');
  });
});

describe('aw blueprint list', () => {
  it('prints each installed blueprint with its package, version and integrity', async () => {
    const root = await installed(registry(V1));
    const run = await aw(root, registry(V1), ['blueprint', 'list', '--json']);
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(JSON.parse(run.stdout)).toEqual([
      { name: 'helpdesk', package: PACKAGE, version: '1.0.0', integrity: release(V1).integrity },
    ]);
    const human = await runCli(['blueprint', 'list'], { cwd: root, env: {} });
    expect(human.code).toBe(EXIT_CODE.ok);
    expect(human.stdout).toContain(PACKAGE);
  });
});

describe('aw blueprint update', () => {
  it('with changes and without --yes exits 3 and changes no file', async () => {
    const fetch = registry(V1, V2);
    const root = await installed(fetch);
    const before = await tree(root);
    const run = await aw(root, fetch, ['blueprint', 'update', 'helpdesk']);
    expect(run.code).toBe(EXIT_CODE.contract);
    expect(fetch.specs.at(-1)).toBe(`${PACKAGE}@latest`);
    expect(run.stdout).toContain(`proposes ${PACKAGE}@1.0.0 -> ${PACKAGE}@1.1.0`);
    expect(run.stdout).toContain('update    resources/ticket.ts');
    expect(run.stdout).toContain('add       tests/ticket.test.ts');
    expect(run.stdout).toContain('add       db/migrations/0004_add_sla.sql');
    expect(run.stderr).toContain('nothing written');
    expect(await tree(root)).toEqual(before);
  });

  it('never overwrites an edited file: a conflict, kept byte-identical, with a sidecar', async () => {
    const fetch = registry(V1, V2);
    const root = await installed(fetch);
    const edited = 'export default function Tickets() {\n  return "mine";\n}\n';
    await writeFile(path.join(root, 'app/tickets/page.tsx'), edited);

    const plan = await aw(root, fetch, ['blueprint', 'update', 'helpdesk', '--to', '1.1.0']);
    expect(plan.code).toBe(EXIT_CODE.contract);
    expect(plan.stdout).toContain(
      'conflict  app/tickets/page.tsx (edited here; the new version is proposed as app/tickets/page.tsx.blueprint-1.1.0)',
    );

    const run = await aw(root, fetch, [
      'blueprint',
      'update',
      'helpdesk',
      '--to',
      '1.1.0',
      '--yes',
    ]);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
    const files = await tree(root);
    expect(files['app/tickets/page.tsx']).toBe(edited);
    expect(files['app/tickets/page.tsx.blueprint-1.1.0']).toBe(V2.parts['app/tickets/page.tsx']);
    expect(files['resources/ticket.ts']).toBe(V2.parts['resources/ticket.ts']);
    expect(files['tests/ticket.test.ts']).toBe('export {};\n');
    expect(files['db/migrations/0004_add_sla.sql']).toContain('"app_desk"."tickets"');
    const entry = (await generatedManifest(root)).entries['blueprint:helpdesk'];
    expect(entry?.source).toMatchObject({ version: '1.1.0' });

    // The unmerged sidecar refuses the next update until it is merged or deleted.
    const again = await aw(root, registry(V1, V2), ['blueprint', 'diff', 'helpdesk']);
    expect(again.code).toBe(EXIT_CODE.problem);
    expect(again.stderr).toContain(
      'app/tickets/page.tsx.blueprint-1.1.0: is the unmerged proposal',
    );
  });

  it('keeps an edited resource the new version drops, and its app.config.ts wiring', async () => {
    const dropsTicket: Version = {
      version: '1.1.0',
      parts: { 'app/tickets/page.tsx': PAGE_V1 },
      migrations: V1.migrations,
    };
    const fetch = registry(V1, dropsTicket);
    const root = await installed(fetch);
    const mine = "export default { name: 'ticket', mine: true };\n";
    await writeFile(path.join(root, 'resources/ticket.ts'), mine);
    const config = (await tree(root))['app.config.ts'];

    const plan = await aw(root, fetch, ['blueprint', 'update', 'helpdesk']);
    expect(plan.stdout).toContain(
      "keep      app.config.ts: import ticket from './resources/ticket.ts'; (now yours)",
    );
    expect(plan.stdout).not.toContain('revert');
    const run = await aw(root, fetch, ['blueprint', 'update', 'helpdesk', '--yes']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
    const files = await tree(root);
    expect(files['resources/ticket.ts']).toBe(mine);
    expect(files['app.config.ts']).toBe(config);
    const raw = JSON.parse(files['aw-generated.json'] ?? '{}') as {
      entries: Record<
        string,
        { files: Record<string, string>; edits: { path: string; added: string }[] }
      >;
    };
    const entry = raw.entries['blueprint:helpdesk'];
    expect(entry?.files['resources/ticket.ts']).toBeUndefined();
    expect(entry?.edits.filter((edit) => edit.path === 'app.config.ts')).toEqual([]);

    // Destroying the blueprint now leaves the developer's resource and its wiring alone.
    const destroy = await runCli(['destroy', 'blueprint', 'helpdesk', '--yes'], {
      cwd: root,
      env: {},
    });
    expect(destroy.code).toBe(EXIT_CODE.ok);
    const after = await tree(root);
    expect(after['resources/ticket.ts']).toBe(mine);
    expect(after['app.config.ts']).toContain("import ticket from './resources/ticket.ts';");
  });

  it('refuses a version with a destructive migration by name, and writes nothing', async () => {
    const fetch = registry(V1, DESTRUCTIVE);
    const root = await installed(fetch);
    const before = await tree(root);
    const run = await aw(root, fetch, ['blueprint', 'update', 'helpdesk', '--yes']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('migrations/0001_drop_status.sql: is not expand-only (DROP)');
    expect(await tree(root)).toEqual(before);
  });

  it('refuses a package whose name is not the installed one', async () => {
    const root = await installed(registry(V1));
    const other = registry({ ...V2, package: '@evil/helpdesk-blueprint' });
    const run = await aw(root, other, ['blueprint', 'update', 'helpdesk', '--yes']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(`but ${PACKAGE} is installed`);
  });

  it('says up to date, exit 0, when the latest is installed', async () => {
    const root = await installed(registry(V1));
    const run = await aw(root, registry(V1), ['blueprint', 'update', 'helpdesk']);
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain('blueprint:helpdesk is up to date');
  });
});

describe('aw blueprint diff', () => {
  it('prints line diffs and exits 3 when there are changes, writing nothing', async () => {
    const fetch = registry(V1, V2);
    const root = await installed(fetch);
    const before = await tree(root);
    const run = await aw(root, fetch, ['blueprint', 'diff', 'helpdesk']);
    expect(run.code).toBe(EXIT_CODE.contract);
    expect(run.stdout).toContain('--- resources/ticket.ts (update)');
    expect(run.stdout).toContain("-export default { name: 'ticket' };");
    expect(run.stdout).toContain("+export default { name: 'ticket', sla: true };");
    expect(await tree(root)).toEqual(before);
  });

  it('exits 0 when the installed version is the latest', async () => {
    const root = await installed(registry(V1));
    const run = await aw(root, registry(V1), ['blueprint', 'diff', 'helpdesk']);
    expect(run.code).toBe(EXIT_CODE.ok);
  });
});

describe('aw destroy blueprint', () => {
  it('removes the installed blueprint and reverts its edits', async () => {
    const root = await generatedProject();
    const before = await tree(root);
    const add = await aw(root, registry(V1), ['blueprint', 'add', PACKAGE, '--yes']);
    expect(add.code).toBe(EXIT_CODE.ok);
    const destroy = await runCli(['destroy', 'blueprint', 'helpdesk', '--yes'], {
      cwd: root,
      env: {},
    });
    expect(destroy.code).toBe(EXIT_CODE.ok);
    expect(await tree(root)).toEqual(before);
  });
});
