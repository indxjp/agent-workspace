import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MAX_TRACED_RUNS,
  PROJECTS,
  STAND_IN,
  devEnvironment,
  chatFailedRunId,
  failedRuns,
  fileSetupCommands,
  skillPublishCommands,
  firstPrompt,
  identityEnvironment,
  identityTargets,
  installSteps,
  parseArguments,
  pointApisAtLoopback,
  consoleSignIn,
  signInFormFields,
  serverCommands,
  workspaceSecrets,
} from './use-cases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GALLERY = path.join(ROOT, 'tests', 'gallery');
const read = (id: string, ...file: string[]): string =>
  readFileSync(path.join(GALLERY, id, ...file), 'utf8');
const secret = () => 'SECRET';

describe('the use cases install', () => {
  it('aw globally, and the SDK with the embedded runtime next to the projects, at one version', () => {
    const [global, local] = installSteps('1.2.3');
    expect(global?.[1]).toContain("'@indx-workspace/aw@1.2.3'");
    expect(local?.[1]).toContain("'@indx-workspace/sdk@1.2.3'");
    expect(local?.[1]).toContain("'@indx-workspace/embedded@1.2.3'");
  });

  it("then the gallery engine's packages, at the versions the installed SDK pins", () => {
    const engine = installSteps('1.2.3')[2];
    expect(engine?.[1]).toMatch(/^pkgs="\$\(node -e .*\)" && npm install /u);
    expect(engine?.[1]).toContain("import('@indx-workspace/sdk/project')");
    expect(engine?.[1]).toContain("ENGINE_PACKAGES['claude-agent-sdk']");
  });
});

describe('the ten use cases', () => {
  it('are the gallery projects, each with an eval file named after it', () => {
    const projects = readdirSync(GALLERY, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'shared' && entry.name !== 'harness')
      .map((entry) => entry.name);
    expect([...PROJECTS].sort()).toEqual(projects.sort());
    expect(PROJECTS).toHaveLength(10);
  });

  it('each have a first prompt to ask', () => {
    for (const id of PROJECTS) {
      const prompt = firstPrompt(read(id, 'evals', `${id}.yaml`));
      expect(prompt, id).toBeTruthy();
    }
  });

  it('start every connector the project file names, and leave no placeholder in a command', () => {
    for (const id of PROJECTS) {
      const yaml = read(id, 'agent-workspace.yaml');
      const servers = serverCommands(yaml, secret, { FILE_ROOT: '/data' });
      const ports = [...yaml.matchAll(/url: http:\/\/127\.0\.0\.1:(\d+)\/mcp/gu)].map((match) =>
        Number(match[1]),
      );
      const mcp = servers.filter((server) => !STAND_IN.test(server.script));
      expect(mcp.map((server) => server.port).sort(), id).toEqual(ports.sort());
      for (const server of servers) {
        expect(Object.values(server.env).join(' '), id).not.toMatch(/\.\.\.|…/u);
        expect(server.script, id).toMatch(/\.mjs$/u);
      }
    }
  });

  it('start every stand-in API a project ships, each runnable from the command line (#890)', () => {
    for (const id of PROJECTS) {
      const standIns = readdirSync(path.join(GALLERY, id), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) =>
          readdirSync(path.join(GALLERY, id, entry.name))
            .map((file) => `${entry.name}/${file}`)
            .filter((file) => STAND_IN.test(file)),
        );
      for (const file of standIns)
        expect(read(id, file), `${id}/${file}`).toContain('process.argv[1]');
      const started = serverCommands(read(id, 'agent-workspace.yaml'), secret).map(
        (server) => server.script,
      );
      expect(started.filter((script) => STAND_IN.test(script)).sort(), id).toEqual(standIns.sort());
    }
  });

  it('start a stand-in for every project whose OpenAPI document names a host that does not resolve (#890)', () => {
    for (const id of PROJECTS) {
      const apis = path.join(GALLERY, id, 'apis');
      const documents = existsSync(apis)
        ? readdirSync(apis).filter((file) => file.endsWith('.openapi.json'))
        : [];
      if (documents.length === 0) continue;
      const started = serverCommands(read(id, 'agent-workspace.yaml'), secret).filter((server) =>
        STAND_IN.test(server.script),
      );
      expect(started.length, id).toBeGreaterThan(0);
    }
  });

  it('start the quotation project stand-in ERP with the token aw dev is given', () => {
    const yaml = read('quotation', 'agent-workspace.yaml');
    const devEnv = devEnvironment(yaml, () => 'ONE');
    expect(serverCommands(yaml, () => 'TWO', devEnv)).toEqual([
      {
        env: {
          ERP_TOKEN: 'ONE',
          ERP_IDENTITY_SECRET: 'TWO',
          IDENTITY_AUDIENCE: '<tool-id>',
          IDENTITY_WORKSPACE: '<workspace-id>',
          PORT: '8790',
        },
        script: 'erp/fake-erp.mjs',
        port: 8790,
        identity: { key: 'ERP_IDENTITY_SECRET', secret: 'ERP_IDENTITY_SECRET' },
      },
    ]);
  });

  it('point the OpenAPI documents of a project at the stand-in, keeping the base path (the host does not resolve)', () => {
    const work = mkdtempSync(path.join(tmpdir(), 'use-cases-test-'));
    try {
      cpSync(path.join(GALLERY, 'quotation', 'apis'), path.join(work, 'apis'), { recursive: true });
      pointApisAtLoopback(work, 8790);
      const document = JSON.parse(
        readFileSync(path.join(work, 'apis', 'erp.openapi.json'), 'utf8'),
      ) as { servers: unknown; paths: object };
      expect(document.servers).toEqual([{ url: 'http://127.0.0.1:8790/api/v1' }]);
      expect(Object.keys(document.paths)).toContain('/parts/search');
      expect(() => pointApisAtLoopback(path.join(work, 'none'), 1)).not.toThrow();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('give the quotation project the ERP token its aw dev line asks for', () => {
    expect(devEnvironment(read('quotation', 'agent-workspace.yaml'), secret)).toEqual({
      ERP_TOKEN: 'SECRET',
    });
    expect(devEnvironment(read('manual-search', 'agent-workspace.yaml'), secret)).toEqual({});
  });
});

describe('what a project needs before aw check', () => {
  const dir = (id: string) => path.join(GALLERY, id);

  it('creates each granted folder, then uploads data/<folder>/ into it (#899)', () => {
    expect(fileSetupCommands(dir('manual-search'))).toEqual([
      "aw files mkdir 'manuals'",
      "aw files upload 'manuals/hydraulic-unit.md' 'data/manuals/hydraulic-unit.md'",
      "aw files upload 'manuals/hydraulic-unit.pdf' 'data/manuals/hydraulic-unit.pdf'",
      "aw files upload 'manuals/safety-rules.md' 'data/manuals/safety-rules.md'",
      "aw files upload 'manuals/safety-rules.pdf' 'data/manuals/safety-rules.pdf'",
    ]);
    const playbook = fileSetupCommands(dir('contract-review')).filter((c) =>
      c.includes('playbook'),
    );
    expect(playbook).toHaveLength(10);
    expect(playbook[0]).toBe("aw files mkdir 'playbook'");
    expect(playbook[1]).toBe(
      "aw files upload 'playbook/PB-01-liability-cap.md' 'data/playbook/PB-01-liability-cap.md'",
    );
  });

  it('publishes revision 1 of a pinned skill before aw push, as the tutorial does', () => {
    expect(skillPublishCommands(dir('contract-review'))).toEqual([
      "aw skills publish 'contract-playbook' './skills/contract-playbook'",
    ]);
    expect(skillPublishCommands(dir('manual-search'))).toEqual([]);
    const work = mkdtempSync(path.join(tmpdir(), 'pin-'));
    try {
      cpSync(dir('contract-review'), work, { recursive: true });
      const agent = path.join(work, 'agents', 'contract-review.ts');
      writeFileSync(agent, readFileSync(agent, 'utf8').replace('revision: 1', 'revision: 2'));
      expect(() => skillPublishCommands(work)).toThrow('pinned to revision 2, not 1');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('uploads the three Word drafts into contracts/<deal-team>/ and a .gitkeep into each drafts/<deal-team>/', () => {
    const commands = fileSetupCommands(dir('contract-review'));
    expect(commands.filter((c) => c.includes("'contracts"))).toEqual([
      "aw files mkdir 'contracts'",
      "aw files upload 'contracts/営業一部/業務委託契約書_株式会社ミナトシステムズ案.docx' 'data/contracts/営業一部/業務委託契約書_株式会社ミナトシステムズ案.docx'",
      "aw files upload 'contracts/営業一部/秘密保持契約書_Harborline Japan案.docx' 'data/contracts/営業一部/秘密保持契約書_Harborline Japan案.docx'",
      "aw files upload 'contracts/購買部/売買基本契約書_北陸精工株式会社案.docx' 'data/contracts/購買部/売買基本契約書_北陸精工株式会社案.docx'",
    ]);
    // A run scoped to drafts/<team> writes there only once the folder exists, and a folder exists once a file is in it.
    expect(commands.filter((c) => c.includes("'drafts"))).toEqual([
      "aw files mkdir 'drafts'",
      "aw files upload 'drafts/営業一部/.gitkeep' 'data/drafts/営業一部/.gitkeep'",
      "aw files upload 'drafts/購買部/.gitkeep' 'data/drafts/購買部/.gitkeep'",
    ]);
  });

  it('only creates a granted folder the project ships no data for, and nothing for a project with no grant', () => {
    expect(fileSetupCommands(dir('cad-drafting'))).toContain("aw files mkdir 'drafts'");
    expect(fileSetupCommands(dir('quotation'))).toEqual([]);
  });

  it('creates every folder once, before any upload into it', () => {
    for (const id of PROJECTS) {
      const commands = fileSetupCommands(dir(id));
      const made = commands.filter((c) => c.startsWith('aw files mkdir '));
      expect(new Set(made).size, id).toBe(made.length);
      commands.forEach((command, at) => {
        expect(command, id).toMatch(/^aw files (?:mkdir|upload) /u);
        const folder = /^aw files upload '([^/]+)\//u.exec(command)?.[1];
        if (folder !== undefined)
          expect(commands.indexOf(`aw files mkdir '${folder}'`), id).toBeLessThan(at);
      });
    }
  });
});

describe('the commands of a project file', () => {
  const yaml = [
    'name: x',
    '# prose that is not indented enough',
    '#   CRM_TOKEN_SECRET=... FILE_ROOT=/srv/x MCP_TRANSPORT=http PORT=8788 node mcp/a.mjs',
    '#   for f in data/*.md; do aw files upload "$f"; done',
    '#   APPROVAL_SECRET=… PORT=8789 node ../b/mcp/b.mjs',
  ].join('\n');

  it('are the node lines, with placeholders filled and overrides applied', () => {
    expect(serverCommands(yaml, secret, { FILE_ROOT: '/data' })).toEqual([
      {
        env: {
          CRM_TOKEN_SECRET: 'SECRET',
          FILE_ROOT: '/data',
          MCP_TRANSPORT: 'http',
          PORT: '8788',
        },
        script: 'mcp/a.mjs',
        port: 8788,
      },
      { env: { APPROVAL_SECRET: 'SECRET', PORT: '8789' }, script: '../b/mcp/b.mjs', port: 8789 },
    ]);
  });
});

describe('the caller identity of a project (#890)', () => {
  const values = (yaml: string): Record<string, string> =>
    Object.fromEntries(workspaceSecrets(yaml).map((name) => [name, `value of ${name}`]));
  const verifying = (id: string) => {
    const yaml = read(id, 'agent-workspace.yaml');
    return serverCommands(yaml, secret, values(yaml)).filter(
      (server) => server.identity !== undefined,
    );
  };

  it('creates the workspace secrets the project file names, once each', () => {
    expect(workspaceSecrets(read('meeting-minutes', 'agent-workspace.yaml'))).toEqual([
      'TASK_TRACKER_IDENTITY_SECRET',
      'TRACKER_IDENTITY_SECRET',
    ]);
    expect(workspaceSecrets(read('quotation', 'agent-workspace.yaml'))).toEqual([
      'ERP_IDENTITY_SECRET',
    ]);
    expect(workspaceSecrets(read('manual-search', 'agent-workspace.yaml'))).toEqual([]);
    const twice = '#   add A_KEY under Secrets in the console, signed in as the Owner\n'.repeat(2);
    expect(workspaceSecrets(twice)).toEqual(['A_KEY']);
  });

  it('gives each verifying server the value of the secret the nearest create line before it names', () => {
    expect(
      verifying('meeting-minutes').map((server) => [server.script, server.identity, server.env]),
    ).toEqual([
      [
        'mcp/tasks.mjs',
        { key: 'IDENTITY_SECRET', secret: 'TASK_TRACKER_IDENTITY_SECRET' },
        expect.objectContaining({ IDENTITY_SECRET: 'value of TASK_TRACKER_IDENTITY_SECRET' }),
      ],
      [
        'tracker/fake-tracker.mjs',
        { key: 'IDENTITY_SECRET', secret: 'TRACKER_IDENTITY_SECRET' },
        expect.objectContaining({ IDENTITY_SECRET: 'value of TRACKER_IDENTITY_SECRET' }),
      ],
    ]);
  });

  it('gives a server keyed by <NAME>_IDENTITY_SECRET the value of that secret', () => {
    const [crm] = verifying('customer-inquiry');
    expect(crm?.identity).toEqual({ key: 'CRM_IDENTITY_SECRET', secret: 'CRM_IDENTITY_SECRET' });
    expect(crm?.env['CRM_IDENTITY_SECRET']).toBe('value of CRM_IDENTITY_SECRET');
  });

  it('pairs every server that verifies the assertion with a secret the project creates', () => {
    for (const id of PROJECTS) {
      const yaml = read(id, 'agent-workspace.yaml');
      const servers = serverCommands(yaml, secret, values(yaml));
      const created = workspaceSecrets(yaml);
      for (const server of servers.filter((s) => 'IDENTITY_AUDIENCE' in s.env)) {
        expect(server.identity, `${id}: ${server.script}`).toBeDefined();
        expect(created, `${id}: ${server.script}`).toContain(server.identity?.secret);
        expect(server.env[server.identity?.key ?? ''], id).toBe(
          `value of ${server.identity?.secret ?? ''}`,
        );
      }
      // Every secret the project creates is one some server verifies with.
      expect(new Set(servers.flatMap((s) => s.identity?.secret ?? [])), id).toEqual(
        new Set(created),
      );
    }
  });

  it('leaves a server that verifies nothing without an identity', () => {
    const servers = serverCommands(read('ringi-review', 'agent-workspace.yaml'), secret);
    expect(servers.find((s) => s.script === 'mcp/authority-server.mjs')?.identity).toBeUndefined();
  });

  it('adds a secret in the console, never with aw secrets create, which aw dev cannot', () => {
    // aw dev holds an Admin key and only an Owner may store a secret (ADR-0109).
    for (const id of PROJECTS) {
      expect(read(id, 'agent-workspace.yaml'), id).not.toMatch(/\baw secrets create\b/u);
    }
  });

  it('reads the console sign-in from the ready screen', () => {
    const ready = [
      '  console   http://127.0.0.1:3001',
      '            sign in as admin@localhost.test',
      '            password in .agent-workspace/secrets/local-secrets.json',
    ].join('\n');
    expect(consoleSignIn(ready)).toEqual({
      url: 'http://127.0.0.1:3001',
      email: 'admin@localhost.test',
      passwordFile: '.agent-workspace/secrets/local-secrets.json',
    });
    expect(() => consoleSignIn('  chat      npx aw chat')).toThrow('names no console sign-in');
  });

  it('posts the hidden fields of the password form, and only that form', () => {
    const html = [
      '<form action="/api/auth/login"><input type="hidden" name="next" value="/"/></form>',
      '<form action="" method="POST"><input type="hidden" name="$ACTION_ID_ab12" value=""/>',
      '<input type="hidden" name="next" value="/a?b=1&amp;c=2"/>',
      '<input type="email" name="email"/><input type="password" name="password"/></form>',
    ].join('');
    expect(signInFormFields(html)).toEqual([
      ['$ACTION_ID_ab12', ''],
      ['next', '/a?b=1&c=2'],
    ]);
    expect(() => signInFormFields('<form></form>')).toThrow('no password form');
  });

  it('reads the connector and workspace each secret signs for from aw connectors list --json', () => {
    const listed = JSON.stringify(
      {
        connectors: [
          { id: 'c-mcp', workspaceId: 'ws-1', name: 'task-tracker', identity: { secret: 'A' } },
          { id: 'c-tool', workspaceId: 'ws-1', name: 'tracker', identity: { secret: 'B' } },
          { id: 'c-plain', workspaceId: 'ws-1', name: 'authority' },
        ],
      },
      null,
      2,
    );
    expect(identityTargets(listed)).toEqual(
      new Map([
        ['A', { connectorId: 'c-mcp', workspaceId: 'ws-1' }],
        ['B', { connectorId: 'c-tool', workspaceId: 'ws-1' }],
      ]),
    );
    expect(identityTargets('[]')).toEqual(new Map());
  });

  it('refuses a list that is not one, or two connectors that sign with one secret', () => {
    expect(() => identityTargets('error: unauthorized')).toThrow('no JSON');
    expect(() => identityTargets('{"items": []}')).toThrow('no connectors');
    const twice = { id: 'c', workspaceId: 'w', identity: { secret: 'A' } };
    expect(() => identityTargets(JSON.stringify({ connectors: [twice, twice] }))).toThrow(
      'more than one connector signs with A',
    );
  });

  it('restarts a verifying server with the real connector id and workspace id', () => {
    const [erp] = verifying('quotation');
    if (erp === undefined) throw new Error('the quotation ERP verifies the caller assertion');
    const targets = new Map([['ERP_IDENTITY_SECRET', { connectorId: 'c-erp', workspaceId: 'ws' }]]);
    expect(identityEnvironment(erp, targets)).toEqual({
      ...erp.env,
      IDENTITY_AUDIENCE: 'c-erp',
      IDENTITY_WORKSPACE: 'ws',
    });
    expect(() => identityEnvironment(erp, new Map())).toThrow(
      'no connector signs its caller assertion with ERP_IDENTITY_SECRET',
    );
    const plain = { env: { PORT: '1' }, script: 'a.mjs', port: 1 };
    expect(identityEnvironment(plain, new Map())).toBe(plain.env);
  });
});

describe('the first prompt of an eval file', () => {
  it('reads a plain, a quoted and a block input', () => {
    expect(firstPrompt('cases:\n  - name: a\n    input: hello there\n')).toBe('hello there');
    expect(firstPrompt('cases:\n  - name: a\n    input: "quoted"\n')).toBe('quoted');
    expect(
      firstPrompt(
        'cases:\n  - name: a\n    input: |\n      line one\n\n      line two\n    expect: {}\n',
      ),
    ).toBe('line one\n\nline two');
    expect(firstPrompt('cases: []\n')).toBeUndefined();
  });
});

describe('the run a failed chat names', () => {
  const RUN = '0b6f3a1e-5d7c-4a52-9d0e-6a3f1c2b4d5e';

  it('is the UUID in `run <id> failed`', () => {
    expect(
      chatFailedRunId(
        `error: run_failed: run ${RUN} failed: The run exceeded its credential-bounded lifetime of 270000ms.\n`,
      ),
    ).toBe(RUN);
  });

  it('is none when the output names no run, or an id that is not a UUID (it is put in a command)', () => {
    expect(chatFailedRunId('error: model_unavailable: no model\n')).toBeUndefined();
    expect(chatFailedRunId('error: run_failed: run 1;rm failed: x')).toBeUndefined();
  });
});

describe('the failed cases of an evaluation', () => {
  const RUN = '0b6f3a1e-5d7c-4a52-9d0e-6a3f1c2b4d5e';
  const evaluation = (results: unknown[]) => JSON.stringify({ id: 'e', results });

  it('are the runs to trace: the failed cases that started one', () => {
    const stdout = evaluation([
      { name: 'ok', passed: true, runId: RUN, failures: [] },
      { name: 'slow', passed: false, runId: RUN, failures: ['deadline_exceeded'] },
    ]);
    expect(failedRuns(stdout)).toEqual([
      { name: 'slow', runId: RUN, failures: ['deadline_exceeded'] },
    ]);
    expect(failedRuns(JSON.stringify([JSON.parse(stdout)]))).toHaveLength(1);
  });

  it('are none when every case passed', () => {
    expect(
      failedRuns(evaluation([{ name: 'ok', passed: true, runId: RUN, failures: [] }])),
    ).toEqual([]);
  });

  it('skip a case that started no run, and a run id that is not a UUID (it is put in a command)', () => {
    const stdout = evaluation([
      { name: 'refused', passed: false, runId: null, failures: ['model_unavailable'] },
      { name: 'odd', passed: false, runId: '1; rm -rf /', failures: ['x'] },
    ]);
    expect(failedRuns(stdout)).toEqual([]);
  });

  it('are at most five, so the traces stay inside the step budget', () => {
    const results = Array.from({ length: 8 }, (_, index) => ({
      name: `case ${String(index)}`,
      passed: false,
      runId: RUN,
      failures: ['x'],
    }));
    expect(MAX_TRACED_RUNS).toBe(5);
    expect(failedRuns(evaluation(results)).map((run) => run.name)).toEqual(
      results.slice(0, 5).map((result) => result.name),
    );
  });

  it('read the exact stdout `aw eval --json` writes, with or without progress lines before it', () => {
    const results = [
      { name: 'wording', passed: false, runId: RUN, failures: ['missing "unitPrice": 440'] },
      { name: 'slow', passed: false, runId: RUN, failures: ['deadline_exceeded'] },
      { name: 'never started', passed: false, runId: null, failures: ['deadline_exceeded'] },
    ];
    const stdout = `${JSON.stringify({ id: 'e', results }, null, 2)}\n`;
    const traced = [
      { name: 'wording', runId: RUN, failures: ['missing "unitPrice": 440'] },
      { name: 'slow', runId: RUN, failures: ['deadline_exceeded'] },
    ];
    expect(failedRuns(stdout)).toEqual(traced);
    expect(failedRuns(`quotation: 3/4 cases\nquotation: 4/4 cases\n${stdout}`)).toEqual(traced);
    expect(failedRuns(`[quotation] 3/4 cases\n${stdout}`)).toEqual(traced);
    expect(
      failedRuns(`quotation: 4/4 cases\n${JSON.stringify([JSON.parse(stdout)], null, 2)}`),
    ).toEqual(traced);
  });

  it('are none, without a throw, when the output is not an evaluation', () => {
    expect(failedRuns('not json')).toEqual([]);
    expect(failedRuns('null')).toEqual([]);
    expect(failedRuns('{"results": 1}')).toEqual([]);
  });
});

describe('the switches', () => {
  it('default to the latest version on the public registry', () => {
    expect(parseArguments([])).toEqual({
      version: 'latest',
      registry: 'https://registry.npmjs.org/',
    });
    expect(parseArguments(['--version', '0.5.1']).version).toBe('0.5.1');
  });

  it('refuse a version that is not one word and an unknown switch', () => {
    expect(() => parseArguments(['--version', '1; rm -rf /'])).toThrow('--version');
    expect(() => parseArguments(['--nope'])).toThrow('usage:');
  });
});
