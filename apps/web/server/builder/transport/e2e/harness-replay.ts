import { randomUUID } from 'node:crypto';
import { createProviderRegistry } from '@agent-workspace/gateway/providers/registry';
import { createRunTokenCodec } from '@agent-workspace/gateway/tokens';
import { canonicalCall, needsApproval } from '@indx-workspace/contracts/agents';
import { BUILDER_APPROVAL_RULES } from '../../agent/definition';
import type { RunApiEnvironment } from '../../../runs/environment';
import { TOOL_PREFIX, type Door } from './harness-contract';

interface ModelBlock {
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
}

interface ReplayContext {
  readonly token: string;
  readonly runId: string;
  readonly gated: boolean;
  /** An approval admits its canonical call once during this replay. */
  readonly consumed: Set<string>;
  readonly call: Door['call'];
  readonly requireRunApi: () => RunApiEnvironment;
}

async function admitsTool(
  context: ReplayContext,
  toolName: string,
  input: unknown,
): Promise<boolean> {
  if (!context.gated || !needsApproval(BUILDER_APPROVAL_RULES, toolName)) return true;
  const text = canonicalCall(toolName, input);
  const run = await context.requireRunApi().store.get(context.runId);
  const approved =
    !context.consumed.has(text) &&
    run?.approvedToolCalls?.some((admitted) => admitted.canonicalCall === text) === true;
  if (approved) {
    context.consumed.add(text);
    return true;
  }
  await context.requireRunApi().store.awaitApproval(context.runId, {
    toolName,
    canonicalCall: text,
  });
  return false;
}

async function replayTool(context: ReplayContext, block: ModelBlock) {
  if (block.type !== 'tool_use' || block.name === undefined) return { kind: 'ignored' } as const;
  if (!block.name.startsWith(TOOL_PREFIX)) {
    throw new Error(`not an aw-control tool: ${block.name}`);
  }
  if (!(await admitsTool(context, block.name, block.input))) return { kind: 'paused' } as const;
  const answer = await context.call(
    context.token,
    block.name.slice(TOOL_PREFIX.length),
    block.input,
    {},
    block.id,
  );
  return {
    kind: 'answered',
    result: {
      type: 'tool_result',
      tool_use_id: block.id,
      is_error: answer.isError,
      content: JSON.stringify(answer.result),
    },
  } as const;
}

export function createScriptedRunner(context: {
  readonly tokens: ReturnType<typeof createRunTokenCodec>;
  readonly call: Door['call'];
  readonly requireRunApi: () => RunApiEnvironment;
}): Door['runScripted'] {
  const { tokens, call, requireRunApi } = context;
  return async function runScripted(token, model, options = {}) {
    const verified = await tokens.verify(token);
    if (!verified.ok) throw new Error('the fixture token does not verify');
    const { runId } = verified.claims;
    const replay: ReplayContext = {
      token,
      runId,
      gated: options.gated === true,
      consumed: new Set<string>(),
      call,
      requireRunApi,
    };
    const [anthropic] = createProviderRegistry();
    if (anthropic === undefined) throw new Error('the gateway registers no provider');
    const providerContext = {
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
        providerContext,
      );
      const message = (await response.json()) as {
        content: ModelBlock[];
        stop_reason: string;
      };
      messages.push({ role: 'assistant', content: message.content });
      if (message.stop_reason !== 'tool_use') return messages;
      const results = [];
      for (const block of message.content) {
        const answer = await replayTool(replay, block);
        if (answer.kind === 'paused') return messages;
        if (answer.kind === 'answered') results.push(answer.result);
      }
      messages.push({ role: 'user', content: results });
    }
  };
}
