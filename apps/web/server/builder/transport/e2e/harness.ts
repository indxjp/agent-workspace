/**
 * The `aw-control` door with everything behind it real except the database: a real run-token
 * codec, the real caller check, the production Builder ports from `productionBuilderPorts` over
 * in-memory stores, and the run's model turns replayed by the gateway's scripted model provider.
 *
 * A whole run (engine, runner and gateway) needs Docker, so a scripted turn is driven here at the
 * route boundary: the model's `tool_use` goes to `POST /api/builder/mcp` with the run's own token,
 * exactly as the gateway forwarder sends it, and the tool result goes back into the conversation.
 * The gateway hop itself is covered by `packages/gateway/src/tools/aw-control.test.ts`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createProviderRegistry } from '@agent-workspace/gateway/providers/registry';
import { createRunTokenCodec, type RunTokenSubject } from '@agent-workspace/gateway/tokens';
import { canonicalCall, needsApproval } from '@indx-workspace/contracts/agents';
import { AW_CONTROL_SERVER, type BuilderToolName } from '@indx-workspace/contracts/builder';
import {
  ScriptedModelScriptSchema,
  type ScriptedModelScript,
} from '@indx-workspace/contracts/models';
import type { RunStatus } from '@indx-workspace/contracts/runs';
import { vi } from 'vitest';

import {
  createInMemoryAgentVersionStoreProvider,
  type InMemoryAgentVersionStoreProvider,
} from '../../../agent-versions/memory-store';
import { createInMemoryAgentStoreProvider } from '../../../agents/memory-store';
import { draftBody } from '../../adapters/checker/checker.contract';
import { BUILDER_APPROVAL_RULES } from '../../agent/definition';
import { ORDER_CASE } from '../../adapters/runner/runner.contract';
import { BUILDER_SHIPPED_SUMMARY } from '../../agent/prompt-version';
import type { AuditDeps } from '../../adapters/audit/store';
import { builderRunReader, productionBuilderPorts } from '../composition';
import { createBuilderCallerVerifier, serveBuilderMcp } from '../mcp';
import type { BuilderPorts } from '../../tools/types';
import { createInMemoryConnectorsStoreProvider } from '../../../connectors/memory-store';
import type { ConnectorsStoreProvider } from '../../../connectors/store';
import { createInMemoryModelsStoreProvider } from '../../../models/memory-store';
import type { Role } from '../../../rbac/roles';
import { createMemoryDirectory } from '../../../rbac/memory-directory';
import { createInMemoryRuntimeProfileStoreProvider } from '../../../runtimes/memory-store';
import { ORDER_STATUS_FRAMES } from '../../../evaluations/fixtures';
import { installTestRunApi, resetTestRunApi } from '../../../application-context-fixtures';
import type { LaunchContext, RunApiEnvironment, RunPrincipal } from '../../../runs/environment';
import { decideRunApproval } from '../../../runs/approval';
import type { RunStore } from '../../../runs/store';

const SECRET = 'builder-door-test-signing-secret-at-least-thirty-two-bytes';
export const WORKSPACE = randomUUID();
const SESSION = randomUUID();
/** The built-in Builder agent the run belongs to, and the version its session pins. */
const BUILDER_AGENT = randomUUID();
const BUILDER_VERSION_ID = randomUUID();
/** The prefix the engine's MCP client puts before an `aw-control` tool's own name. */
const TOOL_PREFIX = `mcp__${AW_CONTROL_SERVER}__`;

const MEMBERS = { builder: 'principal-builder', viewer: 'principal-viewer' } as const;

/** One journal row as the audit adapter hands it to the repository. */
type JournalRow = Parameters<ReturnType<AuditDeps['repositories']['forScope']>['record']>[0];

/** Who started the run: a member with this role, or a principal kind with no person. */
type Starter = { readonly role: keyof typeof MEMBERS } | { readonly apiKey: true };

/** What the scripted conversation holds after one turn: the model's messages and the tool results. */
export type Transcript = readonly { readonly role: string; readonly content: unknown }[];

export interface Door {
  /** The ports behind the door, spied: a second door (the external one) serves over the same stores. */
  readonly ports: BuilderPorts;
  readonly journal: readonly JournalRow[];
  /** The raw body of every `tools/call` response, in order, for checks on what leaves the door. */
  readonly responses: readonly string[];
  /** The headers of every `tools/call` response, in order, as JSON of their `[name, value]` pairs. */
  readonly responseHeaders: readonly string[];
  /** The version store behind the Builder's saves. */
  readonly versions: InMemoryAgentVersionStoreProvider;
  /** Every run the fake run API launched: a trial, an evaluation case, an approval continuation. */
  readonly launched: readonly LaunchContext[];
  /** Every `audit_events` row the version store recorded (`agent-created`, `agent-changed`, `storage-grant-changed`), oldest first. */
  readonly auditEvents: ReturnType<InMemoryAgentVersionStoreProvider['audits']>;
  /**
   * Starts a run of the Builder for `starter` and returns its run token. With `runId` it adopts the
   * run an approval started (`decide`) instead of creating one.
   */
  start(
    starter: Starter,
    model: string,
    runId?: string,
  ): Promise<{ readonly runId: string; readonly token: string }>;
  /** `POST /api/runs/:id/approval` as the person who started the run; answers the continuation run's id. */
  decide(
    runId: string,
    decision: 'approve' | 'reject',
  ): Promise<{ readonly status: number; readonly runId: string }>;
  /** Every call that reached a Builder port or the run reader, as `port.method`, in order. */
  readonly portCalls: readonly string[];
  /** Ends the run: the run row now reads `completed`, so its token is refused. */
  end(runId: string): void;
  /** Revokes the token in the token registry, as a stop or an expiry sweep does. */
  revoke(token: string): Promise<void>;
  /** Sends one MCP `tools/call` with `token`, as the gateway forwarder would. */
  call(
    token: string,
    name: string,
    args: unknown,
    headers?: Readonly<Record<string, string>>,
    /** The engine's tool-use id; the door mints one without it. */
    callId?: string,
  ): Promise<ToolAnswer>;
  /**
   * Replays `script` as the run's model; every `aw-control` tool use goes through the door. With
   * `gated`, the harness mirrors the engine gate and the gateway backstop: a tool the Builder
   * requires approval for pauses the run at `awaiting_approval` unless its run was approved for
   * exactly that call, once.
   */
  runScripted(
    token: string,
    model: string,
    options?: {
      gated?: boolean;
      /** The conversation so far; the scripted model's next turn is the count of assistant messages in it. */
      history?: Transcript;
    },
  ): Promise<Transcript>;
}

interface ToolAnswer {
  /** The HTTP status of the answer: 200 for a tool result, the refusal's status for a bad token. */
  readonly status: number;
  readonly isError: boolean;
  readonly result: Record<string, unknown>;
}

/** Writes `script` as the scripted model `name` and points the gateway's provider at it. */
export async function scriptedModel(name: string, script: ScriptedModelScript): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'builder-scripted-'));
  await writeFile(path.join(dir, `${name}.json`), JSON.stringify(script));
  vi.stubEnv('AW_SCRIPTED_MODELS_DIR', dir);
  return `scripted:${name}`;
}

/** In a checked-in script, `"@draft:a,b"` stands for a valid draft body naming connectors a and b. */
const DRAFT_MARK = '@draft:';

/** Replays `<directory>/<name>.json` as the scripted model `name`, with its draft marks expanded. */
export async function scriptedModelFile(directory: string, name: string): Promise<string> {
  const text = await readFile(path.join(directory, `${name}.json`), 'utf8');
  const script = JSON.parse(text, (_key, value: unknown) =>
    typeof value === 'string' && value.startsWith(DRAFT_MARK)
      ? draftBody('Order desk', value.slice(DRAFT_MARK.length).split(',').filter(Boolean))
      : value,
  ) as unknown;
  return scriptedModel(name, ScriptedModelScriptSchema.parse(script));
}

/** The parsed tool results of a transcript, in the order the model asked for them. */
export function toolResults(transcript: Transcript): unknown[] {
  return transcript.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as { type: string; content?: string }[])
          .filter((block) => block.type === 'tool_result')
          .map((block) => JSON.parse(block.content ?? 'null') as unknown)
      : [],
  );
}

/**
 * The door as production composes it. `featureOn` replaces only the `builder` feature input (the
 * production composition hard-wires it off until #1846 slice 3); every other port is production's.
 */
export function builderDoor(options: {
  readonly featureOn: boolean;
  /** Resolves `WORKSPACE`; a test builds it (`createInMemoryWorkspaceScopeResolver`), as no server module may name core's db. */
  readonly scopes: AuditDeps['scopes'];
  /** The workspace's connectors, when a test seeds them; an empty in-memory store otherwise. */
  readonly connectors?: ConnectorsStoreProvider;
  /**
   * The run store a run's approvals and trials use. A suite builds it (no deployed module may name
   * the in-memory one), and `start` creates its runs in it; without it a run has no approval.
   */
  readonly runStore?: RunStore;
  /** Ports that replace production's, e.g. one that throws; every other port stays production's. */
  readonly override?: Partial<BuilderPorts>;
}): Door {
  const tokens = createRunTokenCodec({ secret: SECRET });
  const { scopes } = options;
  const registered = new Map<string, { runId: string; hash: string }>();
  const runs = new Map<string, { model: string; status: RunStatus }>();
  const portCalls: string[] = [];
  const journal: JournalRow[] = [];
  const responses: string[] = [];
  const responseHeaders: string[] = [];
  const database = {
    scopes,
    runTokens: {
      forScope: () => ({
        isActive: (id: string, runId: string, hash: string) =>
          Promise.resolve(registered.get(id)?.runId === runId && registered.get(id)?.hash === hash),
      }),
    },
    runs: {
      forScope: () => ({
        get: (runId: string) => {
          const run = runs.get(runId);
          return Promise.resolve(
            run === undefined
              ? null
              : {
                  sessionId: SESSION,
                  workspaceId: WORKSPACE,
                  agentId: BUILDER_AGENT,
                  status: run.status,
                  model: run.model,
                  agentVersion: 1,
                },
          );
        },
      }),
    },
    agentVersions: {
      forScope: () => ({
        find: (agentId: string, number: number) =>
          Promise.resolve(
            agentId === BUILDER_AGENT && number === 1
              ? { id: BUILDER_VERSION_ID, number: 1, summary: BUILDER_SHIPPED_SUMMARY }
              : null,
          ),
      }),
    },
    builderToolCalls: {
      forScope: () => ({
        record: (row: JournalRow) => {
          const taken = journal.some(
            (seen) => seen.runId === row.runId && seen.callId === row.callId,
          );
          if (!taken) journal.push(row);
          return Promise.resolve(!taken);
        },
        listForRun: (runId: string) =>
          Promise.resolve(journal.filter((row) => row.runId === runId)),
        findCall: (runId: string, callId: string) =>
          Promise.resolve(
            journal.find((row) => row.runId === runId && row.callId === callId) ?? null,
          ),
        listSpentInputs: (runId: string, tool: string) =>
          Promise.resolve(
            journal
              .filter(
                (row) =>
                  row.runId === runId &&
                  row.tool === tool &&
                  (row.outcome === 'ok' || row.outcome === 'error'),
              )
              .map((row) => row.inputJson),
          ),
      }),
    },
  };
  const directory = createMemoryDirectory({
    users: (Object.entries(MEMBERS) as [Role, string][]).map(([role, principalId]) => ({
      id: `user-${role}`,
      principalId,
      email: `${role}@example.test`,
      name: role,
      workspaceId: WORKSPACE,
      role,
    })),
  });
  const memoryAgents = createInMemoryAgentStoreProvider();
  /** The in-memory store knows no built-in agent, so the Builder is added to what `get` can see. */
  const agents: typeof memoryAgents = {
    ...memoryAgents,
    forWorkspace: (workspaceId) => {
      const store = memoryAgents.forWorkspace(workspaceId);
      return {
        ...store,
        get: async (id) =>
          id === BUILDER_AGENT
            ? {
                id,
                workspaceId,
                name: 'builder',
                builtin: 'builder' as const,
                instructions: '',
                modelConnectionId: null,
                model: null,
                runtimeProfileId: null,
                permissions: {
                  readFiles: false,
                  writeFiles: false,
                  runCommands: false,
                  unrestrictedNetwork: false,
                },
                policy: null,
                createdBy: null,
                ownerPrincipalId: randomUUID(),
                createdAt: new Date(0),
                updatedAt: new Date(0),
              }
            : store.get(id),
      };
    },
  };
  const versions = createInMemoryAgentVersionStoreProvider({
    agents,
    references: { [WORKSPACE]: { connector: [{ id: 'connector-crm', name: 'crm' }] } },
  });
  const { runStore } = options;
  const launched: LaunchContext[] = [];
  const person: RunPrincipal = {
    principalId: MEMBERS.builder,
    ownerPrincipalId: MEMBERS.builder,
    userId: 'user-builder',
    workspaceId: WORKSPACE,
    role: 'owner',
    scope: null,
  };
  // A run with a limit (a trial, an evaluation case) answers the order-status frames and ends; any other stays queued.
  const runApiOver = (store: RunStore): RunApiEnvironment => ({
    authenticate: (request) =>
      Promise.resolve(request.headers.get('x-test-user') === null ? null : person),
    findAgent: (_principal, id) =>
      Promise.resolve({ id, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' }),
    openSession: (_principal, agent, requested, agentVersionId) =>
      Promise.resolve({
        id: requested ?? randomUUID(),
        agentId: agent.id,
        engine: null,
        agentVersionId: agentVersionId ?? null,
      }),
    ownsRun: () => Promise.resolve(true),
    store,
    interruptRun: async (_principal, run) => store.finish(run.id, 'cancelled', null),
    launch(context) {
      launched.push(context);
      if (context.limits === undefined) return;
      void (async () => {
        for (const frame of ORDER_STATUS_FRAMES) {
          await store.append(context.run.id, { type: frame.frame, data: frame });
        }
        await store.finish(context.run.id, 'completed', null, true, {
          text: 'Order 1042 has shipped.',
          structured: null,
        });
      })();
    },
    recordEvaluation: () => Promise.resolve({ id: randomUUID(), createdAt: new Date() }),
  });
  const runApi = runStore === undefined ? null : runApiOver(runStore);
  const requireRunApi = (): RunApiEnvironment => {
    if (runApi === null) throw new Error('This door was built without a runStore.');
    return runApi;
  };
  const ports = productionBuilderPorts({
    agents,
    deploymentPolicy: null,
    versions: {
      versions,
      ceiling: { kind: 'disabled' },
      toolHost: false,
      toolDomainsRefusal: null,
    },
    connectors: options.connectors ?? createInMemoryConnectorsStoreProvider(),
    models: createInMemoryModelsStoreProvider([WORKSPACE]),
    runtimeProfiles: createInMemoryRuntimeProfileStoreProvider(),
    skills: () => Promise.resolve({ status: 200, body: { skills: [] } }),
    storageConnections: () => null,
    toolBundles: () => null,
    journal: { repositories: database.builderToolCalls, scopes },
    directory,
    approvals: {
      scopes,
      runs: {
        forScope: () => ({ get: (id: string) => runStore?.get(id) ?? Promise.resolve(null) }),
      },
    },
    runApi: () => runApi,
  });
  const readRun = builderRunReader(database);
  /** Records which port method each call reaches; the answers are the port's own. */
  function spied<P extends Record<string, object>>(real: P): P {
    const wrapped: Record<string, object> = {};
    for (const [port, impl] of Object.entries(real)) {
      if (typeof impl === 'function') {
        wrapped[port] = impl;
        continue;
      }
      const methods: Record<string, unknown> = {};
      for (const [method, fn] of Object.entries(impl)) {
        methods[method] =
          typeof fn === 'function'
            ? (...args: unknown[]) => {
                portCalls.push(`${port}.${method}`);
                return (fn as (...a: unknown[]) => unknown).apply(impl, args);
              }
            : fn;
      }
      wrapped[port] = methods;
    }
    return wrapped as P;
  }
  const deps = {
    verifyCaller: createBuilderCallerVerifier({
      tokens,
      database,
      directory,
      agents: {
        forWorkspace: () => ({
          get: (id: string) =>
            Promise.resolve(id === BUILDER_AGENT ? { builtin: 'builder' as const } : null),
        }),
      },
    }),
    ports: spied({
      ...(options.featureOn
        ? { ...ports, feature: { enabled: () => Promise.resolve(true) } }
        : ports),
      ...options.override,
    }),
    readRun: (run: Parameters<ReturnType<typeof builderRunReader>>[0]) => {
      portCalls.push('readRun');
      return readRun(run);
    },
  };

  async function call(
    token: string,
    name: string,
    args: unknown,
    headers: Readonly<Record<string, string>> = {},
    callId?: string,
  ): Promise<ToolAnswer> {
    const response = await serveBuilderMcp(
      new Request('http://web.test/api/builder/mcp', {
        method: 'POST',
        headers: {
          ...headers,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            ...(callId === undefined ? {} : { _meta: { 'claudecode/toolUseId': callId } }),
          },
        }),
      }),
      deps,
    );
    const text = await response.text();
    responses.push(text);
    responseHeaders.push(JSON.stringify([...response.headers]));
    const body = JSON.parse(text) as {
      result?: { isError?: boolean; content: { type: string; text: string }[] };
      error?: Record<string, unknown>;
    };
    // The door refuses a token before any JSON-RPC: the answer is the HTTP problem body.
    if (body.result === undefined) {
      return { isError: true, status: response.status, result: { ok: false, ...body.error } };
    }
    const { result } = body;
    const [content] = result.content;
    if (content === undefined) throw new Error('tools/call answered no content');
    return {
      isError: result.isError === true,
      status: response.status,
      result: JSON.parse(content.text) as Record<string, unknown>,
    };
  }

  return {
    ports: deps.ports,
    journal,
    versions,
    launched,
    get auditEvents() {
      return versions.audits();
    },
    responses,
    responseHeaders,
    portCalls,
    end(runId) {
      const run = runs.get(runId);
      if (run === undefined) throw new Error('no such run');
      run.status = 'completed';
    },
    revoke(token) {
      return tokens.verify(token).then((verified) => {
        if (!verified.ok) throw new Error('the fixture token does not verify');
        registered.delete(verified.claims.tokenId);
      });
    },
    async decide(runId, decision) {
      installTestRunApi(requireRunApi());
      try {
        const response = await decideRunApproval(
          new Request(`http://web.test/api/runs/${runId}/approval`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-test-user': '1' },
            body: JSON.stringify({ decision }),
          }),
          runId,
        );
        const body = (await response.json()) as { run?: { id: string } };
        if (body.run === undefined) throw new Error(`approval answered ${response.status}`);
        return { status: response.status, runId: body.run.id };
      } finally {
        resetTestRunApi();
      }
    },
    async start(starter, model, adopt) {
      const runId = adopt ?? randomUUID();
      runs.set(runId, { model, status: 'running' });
      if (runStore !== undefined && adopt === undefined) {
        await runStore.create({
          id: runId,
          engine: 'claude-agent-sdk',
          workspaceId: WORKSPACE,
          agentId: BUILDER_AGENT,
          sessionId: SESSION,
          initiatingUserId: person.userId,
          ownerPrincipalId: person.principalId,
        });
      }
      await runStore?.markRunning(runId);
      const caller: RunTokenSubject['caller'] =
        'apiKey' in starter
          ? { sub: 'api-key-1', principalKind: 'api-key' }
          : { sub: MEMBERS[starter.role], principalKind: 'membership' };
      const token = await tokens.issue({
        runId,
        sessionId: SESSION,
        workspaceId: WORKSPACE,
        agentId: BUILDER_AGENT,
        modelConnectionId: 'connection-1',
        caller,
      });
      const verified = await tokens.verify(token);
      if (!verified.ok) throw new Error('the fixture token does not verify');
      registered.set(verified.claims.tokenId, {
        runId,
        hash: createHash('sha256').update(token).digest('hex'),
      });
      return { runId, token };
    },
    call,
    async runScripted(token, model, options = {}) {
      const verified = await tokens.verify(token);
      if (!verified.ok) throw new Error('the fixture token does not verify');
      const { runId } = verified.claims;
      /** What the gateway's backstop has let through already: an approval admits its call once. */
      const consumed = new Set<string>();
      const [anthropic] = createProviderRegistry();
      if (anthropic === undefined) throw new Error('the gateway registers no provider');
      const context = {
        providerId: anthropic.id,
        credential: 'scripted',
        requestId: randomUUID(),
        settings: {},
        headers: new Headers(),
      } as Parameters<typeof anthropic.createMessage>[1];
      const messages: { role: string; content: unknown }[] = [
        ...(options.history ?? [{ role: 'user', content: 'Check it.' }]),
      ];
      for (;;) {
        const response = await anthropic.createMessage(
          { model, max_tokens: 1024, messages },
          context,
        );
        const message = (await response.json()) as {
          content: { type: string; id?: string; name?: string; input?: unknown }[];
          stop_reason: string;
        };
        messages.push({ role: 'assistant', content: message.content });
        if (message.stop_reason !== 'tool_use') return messages;
        const results = [];
        for (const block of message.content) {
          if (block.type !== 'tool_use' || block.name === undefined) continue;
          if (!block.name.startsWith(TOOL_PREFIX))
            throw new Error(`not an aw-control tool: ${block.name}`);
          if (options.gated === true && needsApproval(BUILDER_APPROVAL_RULES, block.name)) {
            const text = canonicalCall(block.name, block.input);
            const run = await requireRunApi().store.get(runId);
            const approved =
              !consumed.has(text) &&
              run?.approvedToolCalls?.some((admitted) => admitted.canonicalCall === text) === true;
            if (!approved) {
              await requireRunApi().store.awaitApproval(runId, {
                toolName: block.name,
                canonicalCall: text,
              });
              return messages;
            }
            consumed.add(text);
          }
          const answer = await call(
            token,
            block.name.slice(TOOL_PREFIX.length),
            block.input,
            {},
            block.id,
          );
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            is_error: answer.isError,
            content: JSON.stringify(answer.result),
          });
        }
        messages.push({ role: 'user', content: results });
      }
    },
  };
}

/** The three approval-gated tools, and an input each accepts. */
export type GatedTool = 'draft_save' | 'trial_run' | 'evals_run';
export const gatedInputs = ({ agentId, version }: { agentId: string; version: number }) => ({
  draft_save: { body: draftBody('Refund desk', ['crm']) },
  trial_run: { agentId, version, input: 'Where is order 1042?' },
  evals_run: { agentId, version, cases: [ORDER_CASE] },
});

/** The `aw-control` tool use the engine's MCP client sends for `tool`. */
export function toolUse(tool: BuilderToolName, input: Record<string, unknown>) {
  return { name: `${TOOL_PREFIX}${tool}`, input };
}
