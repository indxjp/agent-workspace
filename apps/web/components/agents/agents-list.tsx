'use client';

/**
 * `/agents` — the agent list, transcribed from `ui/agents.html` and wired to the real
 * `GET /api/agents` (W1-CP-05, frozen — see `model.ts`'s header for what this screen does and
 * does not build).
 *
 * Every class below is a translation of a rule in `ui/assets/app.css` (`.page-head`, `.card`,
 * `.tbl`, `.search`, `.btn`, `.callout`), spending the tokens `apps/web/app/globals.css` already
 * ports, in the same idiom `components/run/run-view.tsx` and `components/composer/home-chat.tsx`
 * established.
 *
 * ## Why this fetches from the browser instead of reading the store server-side
 *
 * `app/(shell)/page.tsx` cannot resolve a workspace server-side in this wave for a documented
 * reason — a Server Component has no `Request`, and `AgentsRuntime.resolveWorkspace` needs one.
 * That is a fact about this deployment's session (a cookie carrying a workspace *slug*), not
 * about the request lifecycle, so it applies here identically. A real browser request to
 * `/api/agents`, cookie attached automatically by same-origin `fetch`, does not have that
 * problem: it goes through `middleware.ts`, `withWorkspaceStore` and the composition root's own
 * `resolveWorkspace`, exactly as a curl from an operator's shell would. So this screen fetches,
 * the same way an operator's own tooling would.
 *
 * ## Why the mockup's Status / Runtime / Runs (7d) / Cost (7d) / Last run columns are not here
 *
 * `AgentResource` (`contracts/agents.ts`) has no field for any of the five — no runtime
 * profile, no run count, no cost, no last-run timestamp exists anywhere in this wave's schema.
 * Drawing them would mean inventing numbers, which is the exact failure ADR-0016 is written
 * against one level up (prose) and ADR-0015 is written against here (a capability — "this agent
 * ran 128 times" — asserted because nothing contradicted it). The columns kept are the ones a
 * real `AgentResource` answers: name, instructions (as the `.cell-sub` preview), model and
 * created-at. See docs/adr/W1-UI-04-the-list-shows-only-real-columns.md.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { AgentResource } from '../../contracts/agents';
import { browserClient } from '../../lib/browser-client';
import { ShareDialog } from '../shares/share-dialog';
import {
  describeModel,
  filterAgentsByName,
  formatCreatedAt,
  instructionsPreview,
  type RequestProblem,
} from './model';
import { loadAgents } from './agent-requests-model';
import { BuiltinBadge } from './builtin-badge';

// ── Transcribed class strings ───────────────────────────────────────────────────────────────────

const BTN =
  'inline-flex h-8 items-center justify-center gap-[7px] whitespace-nowrap rounded-(--radius-sm) border px-[13px] text-[13px] font-medium no-underline';
const BTN_PRIMARY = 'border-accent bg-accent text-white dark:text-[#10131c]';
const CARD = 'rounded-(--radius) border border-border bg-surface shadow-(--shadow)';
/**
 * `.callout.danger`. Shape and colour are one constant, not two composed at the call site —
 * `run-view.tsx`'s own `BTN`/`BTN_PRIMARY` split works only because size and colour never touch
 * the same CSS property; border-colour, background and text-colour here all would, and Tailwind
 * resolves two utilities for the same property by their order in the *generated* stylesheet, not
 * by className order, so composing a neutral and a danger variant at the call site is the bug
 * that comment warns about, not a shortcut past it.
 */
const CALLOUT_DANGER =
  'flex items-start gap-[11px] rounded-(--radius) border border-danger bg-danger-soft p-[14px] text-[13px] text-danger';
const SEARCH =
  'flex h-8 min-w-[220px] items-center gap-2 rounded-(--radius-sm) border border-border-strong bg-surface px-2.5';

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      aria-hidden="true"
      className="size-[14px] flex-none text-muted"
    >
      <circle cx="7" cy="7" r="4.2" />
      <path d="m10.2 10.2 3 3" />
    </svg>
  );
}

/** What this screen knows about `GET /api/agents`, at any moment. Never two of these at once. */
type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly agents: readonly AgentResource[] }
  | { readonly kind: 'problem'; readonly problem: RequestProblem };

export function AgentsListScreen() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;

    void loadAgents(browserClient()).then((result) => {
      if (cancelled) return;
      setState(
        result.ok
          ? { kind: 'loaded', agents: result.value }
          : { kind: 'problem', problem: result.problem },
      );
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const total = state.kind === 'loaded' ? state.agents.length : null;
  const visible = state.kind === 'loaded' ? filterAgentsByName(state.agents, query) : [];

  return (
    <main className="w-full max-w-[1120px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-[22px] flex items-start gap-4">
        <div>
          <h1 className="text-[21px]">Agents</h1>
          {total === null ? null : (
            <div className="mt-[3px] text-[13px] text-muted">
              {total === 1 ? '1 agent' : `${String(total)} agents`}
            </div>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className={SEARCH}>
            <SearchIcon />
            <input
              type="search"
              placeholder="Search agents"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              className="h-auto border-0 bg-transparent p-0 text-[13.5px] text-text focus:outline-none"
            />
          </label>
          <Link href="/agents/new" className={`${BTN} ${BTN_PRIMARY}`}>
            New Agent
          </Link>
        </div>
      </div>

      {state.kind === 'loading' ? <p className="text-[13px] text-muted">Loading…</p> : null}

      {state.kind === 'problem' ? (
        <div className={CALLOUT_DANGER}>
          <span aria-hidden="true" className="flex-none text-[14px] leading-[1.4]">
            !
          </span>
          <div className="min-w-0 flex-1">
            {state.problem.kind === 'api' ? (
              <>
                <b className="font-semibold">
                  {state.problem.status} {state.problem.code}
                </b>
                <div>{state.problem.message}</div>
              </>
            ) : (
              <div>{state.problem.reason}</div>
            )}
          </div>
        </div>
      ) : null}

      {state.kind === 'loaded' && state.agents.length === 0 ? (
        <p className="text-[13px] text-muted">This workspace has no agents yet.</p>
      ) : null}

      {state.kind === 'loaded' && state.agents.length > 0 ? (
        <div className={CARD}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="border-b border-border bg-surface-2 px-4 py-[9px] text-left text-[11.5px] font-semibold tracking-[.04em] whitespace-nowrap text-muted uppercase">
                    Agent
                  </th>
                  <th className="border-b border-border bg-surface-2 px-4 py-[9px] text-left text-[11.5px] font-semibold tracking-[.04em] whitespace-nowrap text-muted uppercase">
                    Model
                  </th>
                  <th className="border-b border-border bg-surface-2 px-4 py-[9px] text-left text-[11.5px] font-semibold tracking-[.04em] whitespace-nowrap text-muted uppercase">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((agent) => {
                  const preview = instructionsPreview(agent.instructions);
                  return (
                    <tr key={agent.id} className="hover:bg-surface-2">
                      <td className="border-b border-border px-4 py-[11px] align-middle">
                        <div className="font-semibold">
                          <Link
                            className="text-accent no-underline hover:underline"
                            href={`/agents/${agent.id}`}
                          >
                            {agent.name}
                          </Link>
                          <BuiltinBadge builtin={agent.builtin} />
                        </div>
                        <div className="mt-2">
                          <ShareDialog
                            subject={{ type: 'agent', id: agent.id, label: agent.name }}
                          />
                        </div>
                        {preview === '' ? null : (
                          <div className="text-[12px] text-muted">{preview}</div>
                        )}
                      </td>
                      <td className="border-b border-border px-4 py-[11px] align-middle">
                        {describeModel(agent.model)}
                      </td>
                      <td className="border-b border-border px-4 py-[11px] align-middle whitespace-nowrap">
                        {formatCreatedAt(agent.createdAt)}
                      </td>
                    </tr>
                  );
                })}
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-[11px] text-muted">
                      No agent matches “{query}”.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </main>
  );
}
