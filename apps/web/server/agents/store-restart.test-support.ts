import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

interface RestartOwner {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
}

const restartResult = z.object({
  pid: z.number(),
  mode: z.string(),
  names: z.array(z.string()).optional(),
  outcome: z.string().optional(),
});

export function createAgentRestartDriver({
  directory,
  repoRoot,
  url,
  name,
}: {
  readonly directory: string;
  readonly repoRoot: string;
  readonly url: string;
  readonly name: string;
}) {
  const script = path.join(directory, 'agent-process.ts');
  writeFileSync(script, restartDriverSource(repoRoot), 'utf8');
  return (mode: 'write' | 'read', owner: RestartOwner) =>
    runRestartDriver({ script, url, name, mode, owner });
}

// File URLs keep the child imports valid on both Windows and POSIX.
function restartDriverSource(repoRoot: string): string {
  const specifier = (...segments: string[]): string =>
    pathToFileURL(path.join(repoRoot, ...segments)).href;
  return [
    "import { openDatabaseRoot } from '" +
      specifier('packages', 'core', 'dist', 'db', 'index.js') +
      "';",
    "import { createRepositoryAgentStoreProvider } from '" +
      specifier('apps', 'web', 'server', 'agents', 'store.ts') +
      "';",
    '',
    'const [mode, url, workspaceId, name, principalId, userId] = process.argv.slice(2);',
    "const root = await openDatabaseRoot({ DATABASE_URL: url, DATABASE_POOL_MAX: '2' });",
    'const store = createRepositoryAgentStoreProvider({',
    '  repositories: root.agents,',
    '  scopes: root.scopes,',
    '}).forWorkspace(workspaceId);',
    "if (mode === 'write') {",
    '  const outcome = await store.create({',
    '    name,',
    "    instructions: 'written before the restart',",
    '    modelConnectionId: null,',
    '    model: null,',
    '    permissions: { readFiles: true, writeFiles: false, runCommands: false, unrestrictedNetwork: false },',
    '  }, { principalId, userId });',
    '  console.log(JSON.stringify({ pid: process.pid, mode, outcome: outcome.kind }));',
    "} else if (mode === 'read') {",
    '  const agents = await store.list();',
    '  console.log(JSON.stringify({ pid: process.pid, mode, names: agents.map((a) => a.name) }));',
    '} else {',
    '  console.error(`unknown mode ${mode}`);',
    '  process.exit(2);',
    '}',
    'await root.close();',
  ].join('\n');
}

function runRestartDriver({
  script,
  url,
  name,
  mode,
  owner: { workspaceId, principalId, userId },
}: {
  readonly script: string;
  readonly url: string;
  readonly name: string;
  readonly mode: 'write' | 'read';
  readonly owner: RestartOwner;
}) {
  const output: unknown = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        script,
        mode,
        url,
        workspaceId,
        name,
        principalId,
        userId,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    ).trim(),
  );
  return restartResult.parse(output);
}
