/**
 * Test doubles for the CLI's own suites. Excluded from the build by `tsconfig.build.json`. The
 * `fetch` double records every request; `runCli` runs {@link main} against it with an in-memory
 * process, so a suite asserts stdout, stderr and the exit code without a terminal or a network.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { MenuSpec } from '@indx-workspace/sdk/project';

import type { ChatTerminal, CliIo } from './io.js';
import { main } from './main.js';
import type { ExitCode } from './output.js';

interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly json: unknown;
  readonly body: BodyInit | null | undefined;
  readonly signal: AbortSignal | null;
}

export type Route = (request: RecordedRequest) => Response | Promise<Response>;

function fetchDouble(route: Route): {
  readonly fetch: typeof fetch;
  readonly calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    const body = init?.body;
    const recorded: RecordedRequest = {
      url: new URL(href),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      json: typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined,
      body,
      signal: init?.signal ?? null,
    };
    calls.push(recorded);
    return Promise.resolve(route(recorded));
  };
  return { fetch: impl, calls };
}

export function json(status: number, body: unknown): Response {
  return status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
}

export function eventStream(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

export interface CliRun {
  readonly code: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: readonly RecordedRequest[];
}

export interface CliRunOptions {
  readonly route?: Route;
  /** What standard input holds, or a reader for it (to drive a pipe that never ends). */
  readonly stdin?: string | (() => Promise<string>);
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly signal?: AbortSignal;
  /** The directory the command runs in; a directory that does not exist by default. */
  readonly cwd?: string;
  readonly isTty?: boolean;
  readonly stdinIsTty?: boolean;
  /** Answers `io.prompt`; absent means the process has no prompt. */
  readonly prompt?: (question: string) => Promise<string>;
  /** Answers `io.choose`; absent means the process has no menus (the typed prompt asks). */
  readonly choose?: (spec: MenuSpec) => Promise<readonly string[]>;
  /** Answers `io.promptSecret`; absent means the process has none. */
  readonly promptSecret?: (question: string) => Promise<string>;
  /** Answers `io.openUrl`; absent means the process has none. */
  readonly openUrl?: (url: string) => Promise<boolean>;
  /** Opens the interactive `aw chat` terminal; absent means none is attached. */
  readonly openTerminal?: () => ChatTerminal;
  /**
   * Called after every write with everything written so far, so a suite can act on output as it
   * appears — `aw dev` runs until it is interrupted.
   */
  readonly onOutput?: (output: { readonly stdout: string; readonly stderr: string }) => void;
}

/** The default `cwd`: no project, so the configuration's project step contributes nothing. */
const NO_PROJECT_DIRECTORY = 'C:/nonexistent-project';

const DEFAULT_ENV = {
  AGENT_WORKSPACE_URL: 'https://aw.example.com',
  AGENT_WORKSPACE_API_KEY: 'ak_live_test',
};

/** Run `aw <argv>` with an in-memory process; the environment defaults to a configured one. */
export async function runCli(
  argv: readonly string[],
  options: CliRunOptions = {},
): Promise<CliRun> {
  const api = fetchDouble(
    options.route ?? (() => json(500, { error: { code: 'unexpected', message: 'no route' } })),
  );
  const stdin = options.stdin;
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdin: typeof stdin === 'function' ? stdin : () => Promise.resolve(stdin ?? ''),
    stdout: (text) => {
      stdout += text;
      options.onOutput?.({ stdout, stderr });
    },
    stderr: (text) => {
      stderr += text;
      options.onOutput?.({ stdout, stderr });
    },
    env: options.env ?? DEFAULT_ENV,
    homeDir: options.homeDir ?? 'C:/nonexistent-home',
    fetch: api.fetch,
    isTty: options.isTty ?? false,
    stdinIsTty: options.stdinIsTty ?? options.isTty ?? false,
    cwd: options.cwd ?? NO_PROJECT_DIRECTORY,
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    ...(options.choose === undefined ? {} : { choose: options.choose }),
    ...(options.promptSecret === undefined ? {} : { promptSecret: options.promptSecret }),
    ...(options.openUrl === undefined ? {} : { openUrl: options.openUrl }),
    ...(options.openTerminal === undefined ? {} : { openTerminal: options.openTerminal }),
    // Never a real wait in a suite: `aw login`'s poll interval elapses at once.
    sleep: () => Promise.resolve(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, calls: api.calls };
}

/** Parse one line of JSON output. */
export function stdoutJson(run: CliRun): unknown {
  return JSON.parse(run.stdout) as unknown;
}

/** A fresh directory under the OS temp root; the caller removes it in `afterAll`. */
export function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'aw-test-'));
}

/** Write `content` under `directory` and answer the absolute path. */
export async function tempFile(
  directory: string,
  name: string,
  content: string | Uint8Array,
): Promise<string> {
  const file = path.join(directory, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

/** Contract-valid fixtures, one per resource family, shared by the command suites. */
export const IDS = {
  workspace: '44444444-4444-4444-8444-444444444444',
  agent: '11111111-1111-4111-8111-111111111111',
  run: '33333333-3333-4333-8333-333333333333',
  session: '55555555-5555-4555-8555-555555555555',
  project: '66666666-6666-4666-8666-666666666666',
  connection: '22222222-2222-4222-8222-222222222222',
  principal: '77777777-7777-4777-8777-777777777777',
} as const;

const AT = '2026-09-21T10:00:00.000Z';

export const FIXTURES = {
  membership: {
    id: 'm-1',
    principalId: IDS.principal,
    userId: 'u-1',
    email: 'ada@example.com',
    name: 'Ada',
    role: 'admin',
    createdAt: AT,
  },
  user: { id: 'u-1', email: 'ada@example.com', name: 'Ada', createdAt: AT },
  apiKey: {
    id: 'k-1',
    name: 'ci',
    role: 'builder',
    keyPrefix: 'ak_live_AAAAAAAAAAAAAAAAAAAAAA',
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: AT,
  },
  mintedKey: `ak_live_AAAAAAAAAAAAAAAAAAAAAA_${'B'.repeat(43)}`,
  modelConnection: {
    id: IDS.connection,
    name: 'anthropic',
    provider: 'anthropic',
    config: {},
    hasCredential: true,
    ready: true,
    createdAt: AT,
    updatedAt: AT,
  },
  discoveredModel: {
    connectionId: IDS.connection,
    providerModelId: 'claude-x',
    displayName: 'Claude X',
    capabilities: {
      streaming: true,
      toolUse: true,
      thinking: true,
      promptCaching: true,
      structuredOutput: false,
      contextManagement: false,
      webSearch: false,
      tokenCounting: true,
    },
  },
  runtimeProfile: {
    id: 'rp-1',
    workspaceId: IDS.workspace,
    name: 'docker-small',
    driver: 'docker',
    runtimeConnectionId: null,
    cpu: 1,
    memoryMb: 1024,
    diskMb: null,
    networkPolicy: 'restricted',
    allowedDomains: ['api.anthropic.com'],
    filesystem: 'read-write',
    persistPaths: null,
    timeoutSeconds: 600,
    idleTimeoutSeconds: null,
    driverConfig: null,
    createdAt: AT,
    updatedAt: AT,
  },
  runtimeConnection: {
    id: 'rc-1',
    name: 'RUNTIME_CONNECTION__DOCKER__PRIMARY',
    driver: 'docker',
    createdAt: AT,
  },
  secret: {
    id: 's-1',
    name: 'GITHUB_TOKEN',
    algorithm: 'aes-256-gcm',
    masterKeyId: 'mk-1',
    createdAt: AT,
    updatedAt: AT,
  },
  file: {
    id: 'f-1',
    path: 'docs/readme.md',
    kind: 'file',
    sizeBytes: 5,
    contentType: 'text/markdown',
    lastModified: AT,
  },
  folder: {
    id: 'f-2',
    path: 'docs',
    kind: 'folder',
    sizeBytes: null,
    contentType: null,
    lastModified: null,
  },
  skill: {
    id: '88888888-8888-4888-8888-888888888888',
    name: 'release-notes',
    enabled: true,
    description: 'Write release notes',
    fileCount: 2,
    createdAt: AT,
    updatedAt: AT,
    source: '---\ndescription: Write release notes\n---\nDo it.',
    instructions: 'Do it.',
    allowedTools: null,
    files: [
      { path: 'SKILL.md', sizeBytes: 48 },
      { path: 'templates/notes.md', sizeBytes: 12 },
    ],
  },
  connector: {
    id: 'c-1',
    workspaceId: IDS.workspace,
    name: 'github',
    transport: 'http',
    command: null,
    args: null,
    url: 'https://mcp.example.com',
    authType: 'bearer',
    hasCredential: true,
    enabled: true,
    createdBy: null,
    ownerPrincipalId: IDS.principal,
    createdAt: AT,
    updatedAt: AT,
  },
  engine: {
    id: 'claude-agent-sdk',
    displayName: 'Claude Agent SDK',
    version: '0.3.278',
    capabilities: {
      mcp: true,
      skills: true,
      subagents: false,
      resume: true,
      fork: false,
      interrupt: true,
      streamingText: false,
      reasoning: true,
      maxTurns: 'native',
      maxBudget: 'native',
      wireProtocols: ['anthropic-messages'],
    },
    installed: true,
  },
  agent: {
    id: IDS.agent,
    workspaceId: IDS.workspace,
    name: 'Summariser',
    instructions: 'Summarise.',
    modelConnectionId: IDS.connection,
    model: 'claude-x',
    runtimeProfileId: null,
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
    createdBy: null,
    ownerPrincipalId: IDS.principal,
    createdAt: AT,
    updatedAt: AT,
  },
  assignments: {
    files: [{ fileId: 'f-1', access: 'read' }],
    skillIds: ['release-notes'],
    connectorIds: ['c-1'],
  },
  policy: {
    engine: 'claude-agent-sdk',
    tools: {
      base: 'claude_code_preset',
      autoApprove: [],
      deny: ['Bash'],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    skills: { mode: 'allowlist', names: ['release-notes'] },
    limits: { maxTurns: 20, maxBudgetUsd: null },
  },
  project: {
    id: IDS.project,
    workspaceId: IDS.workspace,
    name: 'Launch',
    instructions: null,
    defaultAgentId: IDS.agent,
    defaultModelConnectionId: null,
    defaultModel: null,
    visibility: 'workspace',
    createdBy: null,
    ownerPrincipalId: IDS.principal,
    archivedAt: null,
    createdAt: AT,
    updatedAt: AT,
    fileIds: [],
    mcpServerIds: [],
  },
  session: {
    id: IDS.session,
    workspaceId: IDS.workspace,
    agentId: IDS.agent,
    userId: null,
    ownerPrincipalId: IDS.principal,
    projectId: null,
    engineSessionId: 'claude-sess-1',
    engine: 'claude-agent-sdk',
    title: null,
    status: 'active',
    resumable: true,
    createdAt: AT,
    updatedAt: AT,
  },
  share: {
    id: 'sh-1',
    subjectType: 'session',
    subjectId: IDS.session,
    subjectLabel: 'A session',
    visibility: 'public',
    mode: null,
    snapshot: null,
    include: {},
    budgetCapUsd: null,
    spentUsd: '0.000000',
    stopped: false,
    expiresAt: null,
    revokedAt: null,
    suspendedAt: null,
    createdAt: AT,
    viewCount: 3,
    url: '/p/token',
  },
  telemetry: {
    runId: IDS.run,
    workspaceId: IDS.workspace,
    agentId: IDS.agent,
    status: 'completed',
    durationMs: 1200,
    costUsd: 0.01,
  },
  auditEvent: {
    id: 'a-1',
    workspaceId: IDS.workspace,
    actorUserId: null,
    actorPrincipalId: IDS.principal,
    actorLabel: 'ci key',
    action: 'agent-changed',
    subjectId: IDS.agent,
    subjectLabel: 'Summariser',
    createdAt: AT,
  },
} as const;

export function runFixture(status: string) {
  return {
    id: IDS.run,
    workspaceId: IDS.workspace,
    agentId: IDS.agent,
    projectId: null,
    initiatingUserId: null,
    sessionId: IDS.session,
    status,
    createdAt: AT,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    model: null,
    provider: null,
    modelConnectionId: null,
    engine: 'claude-agent-sdk',
    engineVersion: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
    },
    cost: { amount: '0.000000', currency: 'USD', priceTableVersion: null },
    error: null,
    accountingState: 'pending',
    accountingError: null,
  };
}
