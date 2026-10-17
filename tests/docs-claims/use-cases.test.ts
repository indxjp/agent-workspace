import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MAX_TRACED_RUNS,
  PROJECTS,
  devEnvironment,
  chatFailedRunId,
  failedRuns,
  fileSetupCommands,
  firstPrompt,
  installSteps,
  parseArguments,
  pointApisAtLoopback,
  serverCommands,
  sharedSkills,
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
      const mcp = servers.filter((server) => !server.script.endsWith('fake-erp.mjs'));
      expect(mcp.map((server) => server.port).sort(), id).toEqual(ports.sort());
      for (const server of servers) {
        expect(Object.values(server.env).join(' '), id).not.toMatch(/\.\.\.|…/u);
        expect(server.script, id).toMatch(/\.mjs$/u);
      }
    }
  });

  it('start the quotation project stand-in ERP with the token aw dev is given', () => {
    const yaml = read('quotation', 'agent-workspace.yaml');
    const devEnv = devEnvironment(yaml, () => 'ONE');
    expect(serverCommands(yaml, () => 'TWO', devEnv)).toEqual([
      { env: { ERP_TOKEN: 'ONE', PORT: '8790' }, script: 'erp/fake-erp.mjs', port: 8790 },
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
      "aw files upload 'manuals/safety-rules.md' 'data/manuals/safety-rules.md'",
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

  it('uploads the three Word drafts into contracts/, which the agent reviews', () => {
    expect(
      fileSetupCommands(dir('contract-review')).filter((c) => c.includes("'contracts")),
    ).toEqual([
      "aw files mkdir 'contracts'",
      "aw files upload 'contracts/売買基本契約書_北陸精工株式会社案.docx' 'data/contracts/売買基本契約書_北陸精工株式会社案.docx'",
      "aw files upload 'contracts/業務委託契約書_株式会社ミナトシステムズ案.docx' 'data/contracts/業務委託契約書_株式会社ミナトシステムズ案.docx'",
      "aw files upload 'contracts/秘密保持契約書_Harborline Japan案.docx' 'data/contracts/秘密保持契約書_Harborline Japan案.docx'",
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

  it('copies a shared skill an agent names into the project, and only that', () => {
    expect(sharedSkills(dir('excel-consolidation'))).toEqual(['office-reader']);
    for (const id of PROJECTS.filter((id) => id !== 'excel-consolidation')) {
      expect(sharedSkills(dir(id)), id).toEqual([]);
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
