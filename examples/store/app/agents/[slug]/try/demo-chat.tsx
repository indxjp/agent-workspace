'use client';
/**
 * The Try it section once the visitor is signed in: a real chat with the entry's demo agent in the
 * visitor's own demo workspace. Tool calls, approval waits and answers appear as the run's events
 * arrive, drawn with the SDK chat's own parts (`ToolTrace`, `ApprovalPrompt`, `AssistantProse`).
 * The runs left come from the platform; a cap turns the chat into the recording fallback.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import {
  DEMO_ALLOWANCE_PATH,
  DemoAllowanceSchema,
  type DemoAllowance,
  type DemoFallbackReason,
} from '@indx-workspace/contracts/demo';
import type { RunApprovalDecision } from '@indx-workspace/contracts/runs';
import { ApprovalPrompt, AssistantProse, ResultChart, ToolTrace } from '@indx-workspace/react';
import { ApiProblemError, runFailure, type AgentWorkspaceClient } from '@indx-workspace/sdk';

import type { LiveEntry } from '../../../../catalog/define';
import { recordingFor } from '../../../../catalog/recording';
import { RECORDINGS } from '../../../../catalog/recordings.generated';
import { pick, type Lang } from '../../../lang';
import { callPlatform } from '../../../platform-api';
import { chartsFor } from './charts';
import { Fallback } from './fallback';
import { allowanceText, chatFallback, fallbackReasonOf } from './messages';
import { applyFrame, beginTurn, continueTurn, type Turn } from './transcript';
import { WORDS } from './words';

type Problem = 'start' | 'stream' | 'approval' | 'agent';

export function DemoChat({
  entry,
  lang,
  platformUrl,
  client,
}: {
  readonly entry: LiveEntry;
  readonly lang: Lang;
  readonly platformUrl: string;
  readonly client: AgentWorkspaceClient;
}) {
  const [agentId, setAgentId] = useState<string | null>(null);
  const [allowance, setAllowance] = useState<DemoAllowance | null>(null);
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [fallback, setFallback] = useState<DemoFallbackReason | null>(null);
  // A run that stopped at its own cap: that answer ended, the visitor's other runs are untouched.
  const [runStop, setRunStop] = useState<DemoFallbackReason | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [decisionPending, setDecisionPending] = useState(false);
  const sessionId = useRef<string | null>(null);
  // A run waiting for approval must be settled before another prompt goes out.
  const waiting = turns.some((turn) => turn.pendingApproval !== null);

  const refreshAllowance = useCallback(async () => {
    const answer = await callPlatform(platformUrl, DEMO_ALLOWANCE_PATH, DemoAllowanceSchema);
    if (answer.ok) setAllowance(answer.value);
  }, [platformUrl]);

  useEffect(() => {
    void refreshAllowance();
    client.agents
      .list()
      .then((agents) => {
        // The provisioner copies the template agent under its own name: the name is the whole rule.
        const copy = agents.find((agent) => agent.name === entry.demo.agent);
        if (copy === undefined) setProblem('agent');
        else setAgentId(copy.id);
      })
      .catch(() => {
        setProblem('agent');
      });
  }, [client, entry.demo.agent, refreshAllowance]);

  const change = (runId: string, update: (turn: Turn) => Turn) => {
    setTurns((all) => all.map((turn) => (turn.runId === runId ? update(turn) : turn)));
  };

  /** Follow `runId` to its end, drawing each event; then read what stopped it. */
  const follow = async (runId: string) => {
    try {
      // The same frames, folded locally, tell why the run ended without touching React state.
      let seen = beginTurn(runId, '');
      for await (const frame of client.runs.follow(runId)) {
        seen = applyFrame(seen, frame);
        change(runId, (turn) => applyFrame(turn, frame));
      }
      const run = await client.runs.get(runId);
      sessionId.current = run.sessionId;
      const code = runFailure(run)?.code ?? null;
      const stop = fallbackReasonOf({ code, stopReason: seen.stopReason });
      if (stop !== null) setRunStop(stop.reason);
      change(runId, (turn) => ({
        ...turn,
        status: run.status,
        pendingApproval: run.pendingApproval,
        structured: run.output?.structured ?? null,
      }));
    } catch {
      setProblem('stream');
    }
  };

  const send = async (prompt: string) => {
    if (agentId === null || busy || waiting || prompt.trim() === '') return;
    setBusy(true);
    setProblem(null);
    setRunStop(null);
    try {
      // The entry's schema, when it declares one, so the answer comes back typed and is charted.
      const { outputSchema } = entry.demo;
      const started = await client.runs.start(agentId, {
        prompt,
        sessionId: sessionId.current,
        ...(outputSchema === undefined ? {} : { outputSchema }),
      });
      setTurns((all) => [
        ...all,
        { ...beginTurn(started.run.id, prompt), status: started.run.status },
      ]);
      await follow(started.run.id);
    } catch (error) {
      const refusal =
        error instanceof ApiProblemError ? fallbackReasonOf({ code: error.code }) : null;
      if (refusal === null) setProblem('start');
      else setFallback(refusal.reason);
    }
    setBusy(false);
    void refreshAllowance();
  };

  const decide = async (
    runId: string,
    decision: RunApprovalDecision,
    comment: string | undefined,
  ) => {
    const turn = turns.find((t) => t.runId === runId);
    if (turn === undefined || decisionPending) return;
    setDecisionPending(true);
    setProblem(null);
    try {
      const input = comment === undefined ? {} : { comment };
      const answer = await (decision === 'approve'
        ? client.runs.approve(turn.runId, input)
        : client.runs.reject(turn.runId, input));
      setTurns((all) =>
        all.map((t) => (t.runId === turn.runId ? continueTurn(t, answer.run.id) : t)),
      );
      setBusy(true);
      await follow(answer.run.id);
      setBusy(false);
    } catch (error) {
      const refusal =
        error instanceof ApiProblemError ? fallbackReasonOf({ code: error.code }) : null;
      if (refusal === null) setProblem('approval');
      else setFallback(refusal.reason);
    }
    setDecisionPending(false);
    void refreshAllowance();
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem('prompt');
    if (!(field instanceof HTMLTextAreaElement)) return;
    const prompt = field.value;
    field.value = '';
    void send(prompt);
  };

  const recording = recordingFor(RECORDINGS, entry.slug, lang);
  const stopped = chatFallback(fallback, runStop !== null, allowance);
  if (stopped !== null) {
    return <Fallback reason={stopped} lang={lang} recording={recording} />;
  }

  return (
    <section data-testid="try-chat" aria-label={pick(WORDS.chatLabel, lang)}>
      {allowance === null ? null : (
        <p data-testid="try-allowance">{allowanceText(allowance, lang)}</p>
      )}
      <ul aria-label={pick(WORDS.promptsLabel, lang)}>
        {entry.demo.prompts.map((prompt) => (
          <li key={prompt.en}>
            <button
              type="button"
              disabled={busy || waiting || agentId === null}
              onClick={() => void send(pick(prompt, lang))}
            >
              {pick(prompt, lang)}
            </button>
          </li>
        ))}
      </ul>
      {turns.map((turn, index) => (
        <article key={index} aria-label={turn.prompt}>
          <p>{turn.prompt}</p>
          <ToolTrace mode="full" steps={turn.tools} strings={WORDS.toolStrings(lang)} />
          {turn.answers.map((answer) => (
            <AssistantProse key={answer.id} text={answer.text} />
          ))}
          {chartsFor(entry.slug, turn.structured).map((chart, at) => (
            <ResultChart key={at} chart={chart} structured={turn.structured} locale={lang} />
          ))}
          {turn.pendingApproval === null ? null : (
            <ApprovalPrompt
              call={turn.pendingApproval}
              strings={WORDS.approvalStrings(lang)}
              pending={decisionPending}
              problem={problem === 'approval' ? pick(WORDS.approvalProblem, lang) : null}
              onDecide={(decision, comment) => void decide(turn.runId, decision, comment)}
            />
          )}
        </article>
      ))}
      {runStop === null ? null : (
        <Fallback reason={runStop} scope="run" lang={lang} recording={recording} />
      )}
      {problem === null || problem === 'approval' ? null : (
        <p role="alert">{pick(WORDS.problems[problem], lang)}</p>
      )}
      <form onSubmit={onSubmit}>
        <label>
          {pick(WORDS.messageLabel, lang)}
          <textarea name="prompt" rows={2} />
        </label>
        <button type="submit" disabled={busy || waiting || agentId === null}>
          {pick(WORDS.send, lang)}
        </button>
      </form>
    </section>
  );
}
