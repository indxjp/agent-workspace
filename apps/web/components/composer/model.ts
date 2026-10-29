/**
 * The home composer's state, as pure functions — spec §19.5.1 rules 1, 2 and 4.
 *
 * The screen itself is a transcription of `ui/home.html` and lives in `home-chat.tsx`. What lives
 * here is the part of §19.5.1 that is *behaviour* rather than layout, kept out of the component so
 * it can be asserted directly:
 *
 *   * **Rule 2 — the pickers narrow, never widen.** A picker may offer only what the selected agent
 *     is already permitted to use. That is enforced structurally rather than by filtering: a
 *     {@link ComposerAgent} carries *its own* permitted file and connector sets, and no
 *     workspace-wide list exists anywhere in this module or in the component tree. There is
 *     therefore no superset to accidentally render and no filter a later edit can forget to apply.
 *     {@link offeredBy} is the only way to reach a picker's options and it can only reach the
 *     agent's own arrays.
 *
 *   * **Rule 4 — switching the agent starts a new session.** {@link selectAgent} does not migrate
 *     the per-session selections onto the new agent; it mints a session with a new key and no
 *     selections. That is also the strongest possible form of rule 2, because nothing can survive a
 *     switch that the new agent does not permit — there is nothing to survive.
 *
 * ## ADR-0015 — every decision here is a positive assertion
 *
 * Each function parses its input before it compares, and each ends in a total branch that rejects
 * and names what it rejected. An option is selected because it was **found** in the selected
 * agent's own list, never because no rule objected to it; an unknown agent id is a named rejection,
 * not a silent no-op that leaves the previous agent selected while the caller believes it switched.
 * The two mutating functions return a discriminated result rather than throwing or returning the
 * input unchanged, so a caller cannot mistake "refused" for "nothing to do".
 */
import { UuidSchema } from '@indx-workspace/contracts';
import type { BuiltinAgentKey } from '@indx-workspace/contracts/agents';
import { StartRunRequestSchema } from '@indx-workspace/contracts/runs';
import type { Badge } from '@indx-workspace/react/run-model';

export type { Badge } from '@indx-workspace/react/run-model';

/** One row inside a Files or Connectors picker — the mockup's `.opt` with its `.t` and `.d` lines. */
export interface PickerOption {
  readonly id: string;
  /** The `.t` line. */
  readonly name: string;
  /** The `.d` line beneath it. */
  readonly detail: string;
}

/**
 * What a new run of one agent would use, as the server described it from stored configuration
 * (issue #393) — so the composer can say which agent and model a message will run on before it is
 * sent, and prefer an agent that can run at all.
 *
 * `unknown` is a deployment whose run API offers no description (no run API installed): nothing is
 * claimed either way.
 */
export type ComposerRunTarget =
  | {
      readonly kind: 'runnable';
      /**
       * `agent` when the model is the agent's own choice; `project` or `workspace` when it inherits
       * that default; `deployment` when the agent names no model, no project or workspace default
       * applies, and the deployment's default model for the provider of the agent's connection (or
       * of the workspace's connection named `default`) applies (issue #506).
       */
      readonly source: 'agent' | 'project' | 'workspace' | 'deployment';
      readonly connectionName: string;
      readonly model: string;
    }
  | { readonly kind: 'unrunnable'; readonly code: string; readonly reason: string }
  | { readonly kind: 'unknown' };

/**
 * One agent the composer may run this message as.
 *
 * `files` and `connectors` are **this agent's permissions**, not a workspace catalogue filtered down
 * to them. Whoever builds this value has already done the narrowing, at the only place that can do
 * it correctly — next to the agent record. See the rule-2 note in the module header.
 */
export interface ComposerAgent {
  readonly id: string;
  /** Saved default; a run may select another connection without changing this value. */
  readonly modelConnectionId?: string | null;
  /** The `.t` line in the agent picker, and the text after "Agent: " in the summary. */
  readonly name: string;
  /** The `.d` line beneath it. */
  readonly detail: string;
  /** Exactly the workspace files this agent may read. Empty means the picker offers none. */
  readonly files: readonly PickerOption[];
  /** Exactly the MCP connectors this agent may use. */
  readonly connectors: readonly PickerOption[];
  /** The line before **Send** — the mockup's "Standard Sandbox · read-only". */
  readonly sandbox: string;
  /** What a run of this agent would use outside any project — issue #393. */
  readonly runTarget: ComposerRunTarget;
  /**
   * What a run would use when the composer files it under a project whose default model sits on
   * this agent's ladder, by project id (PR #403 review). A project not listed changes nothing.
   */
  readonly runTargetByProject?: Readonly<Record<string, ComposerRunTarget>>;
  /**
   * The model providers this agent's engine can reach through the gateway. The model picker offers
   * only models on these (`../models/engine-models.ts`).
   */
  readonly drivableProviders: readonly string[];
  /** Present only on a built-in agent, such as the Builder: listed, but never picked by default. */
  readonly builtin?: BuiltinAgentKey;
}

/**
 * Superseded by issue #130's `(connectionId, providerModelId)` pair — a bare connection id is no
 * longer a well-formed run override on its own (`server/runs/api.ts`'s `parseStartRunBody` refuses
 * one without a paired `model`). No caller in `apps/web` constructs this type any more; it stays
 * exported only so a stale import fails to compile rather than silently linking against a shape
 * `home-chat.tsx` no longer produces.
 */
export interface ComposerModelConnection {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
}

/**
 * One project the composer may open this session in — issue #123's "Project selection in the
 * composer sets the project on session start". Unlike {@link ComposerAgent}'s files and
 * connectors, a project is not one of §19.5.1's narrowing pickers: it does not change what the
 * selected agent may use, only which project (`POST /api/projects/:id/sessions`) the resulting
 * session is filed under. So it carries no permitted-set fields at all — see `home-chat.tsx` for
 * where that association is actually made, after the session exists.
 */
export interface ComposerProject {
  readonly id: string;
  readonly name: string;
}

/** The two narrowing pickers. The agent picker is not one of these: it selects, it does not narrow. */
export type PickerKind = 'files' | 'connectors';

/** One row of the **Recent** list. */
export interface RecentSession {
  readonly id: string;
  readonly title: string;
  /** Badges rendered beside the title. The mockup shows "Shared" on a publicly linked run. */
  readonly titleBadges: readonly Badge[];
  /** The `.meta` line: agent, then whatever else the row has to say, then how long ago. */
  readonly meta: string;
  readonly status: Badge;
  /** The cost cell, already formatted, or `null` when the run has no cost to show. */
  readonly cost: string | null;
  /** Where the row navigates, or `null` when the run view does not exist yet. */
  readonly href: string | null;
}

/**
 * The per-message state §19.5.1 rule 1 calls a session: which agent runs it, and which of that
 * agent's files and connectors this message may use.
 *
 * `key` changes on every agent switch and never otherwise. It exists so "a new session started" is
 * an observable fact rather than an inference from cleared arrays — two switches away and back to
 * the same agent produce two different keys, and both are new sessions.
 */
export interface ComposerSession {
  readonly key: number;
  readonly agentId: string;
  /** Ids drawn from the selected agent's own `files`. Never from anywhere else. */
  readonly files: readonly string[];
  /** Ids drawn from the selected agent's own `connectors`. */
  readonly connectors: readonly string[];
}

/** The options a picker may offer. Total over {@link PickerKind}; there is no third source. */
export function offeredBy(agent: ComposerAgent, kind: PickerKind): readonly PickerOption[] {
  switch (kind) {
    case 'files':
      return agent.files;
    case 'connectors':
      return agent.connectors;
    default: {
      // Unreachable while `kind` is a PickerKind, and a rejection rather than a fallthrough if a
      // later edit widens the union without widening this switch (ADR-0015).
      const unknown: never = kind;
      throw new TypeError(`no picker of kind ${JSON.stringify(unknown)} exists`);
    }
  }
}

/** The ids currently selected in one picker. Total over {@link PickerKind} for the same reason. */
export function selectedIn(session: ComposerSession, kind: PickerKind): readonly string[] {
  switch (kind) {
    case 'files':
      return session.files;
    case 'connectors':
      return session.connectors;
    default: {
      const unknown: never = kind;
      throw new TypeError(`no picker of kind ${JSON.stringify(unknown)} exists`);
    }
  }
}

/**
 * The agent with this id, or `null`.
 *
 * The id is parsed before it is compared: a non-string, or an id no agent carries, produces `null`
 * rather than reaching an `===` that would merely be false (ADR-0015).
 */
export function findAgent(
  agents: readonly ComposerAgent[],
  agentId: unknown,
): ComposerAgent | null {
  if (typeof agentId !== 'string') return null;
  if (agentId === '') return null;
  for (const agent of agents) {
    if (agent.id === agentId) return agent;
  }
  return null;
}

// The pin's version is the run-start input's `version`: the number a session may be started on.
const PinnedVersionSchema = StartRunRequestSchema.unwrap().shape.version.unwrap();

/** An agent version a new chat is pinned to: the pair `/?agent=<uuid>&version=<n>` names. */
export interface PinnedAgent {
  readonly agentId: string;
  readonly version: number;
}

type SearchValue = string | readonly string[] | undefined;

/**
 * The pin a URL asks for, or `null`. A pin needs both parameters to be well formed; a repeated,
 * missing or malformed one leaves the chat unpinned rather than guessing.
 */
export function pinnedAgentFrom(params: {
  readonly agent?: SearchValue;
  readonly version?: SearchValue;
}): PinnedAgent | null {
  const { agent, version } = params;
  if (
    typeof agent !== 'string' ||
    typeof version !== 'string' ||
    !/^[1-9]\d{0,9}$/u.test(version)
  ) {
    return null;
  }
  const agentId = UuidSchema.safeParse(agent);
  const number = PinnedVersionSchema.safeParse(Number(version));
  return agentId.success && number.success ? { agentId: agentId.data, version: number.data } : null;
}

/** The home chat route, pinned to `version` of `agentId`; {@link pinnedAgentFrom} reads it back. */
export function pinnedChatHref({ agentId, version }: PinnedAgent): string {
  return `/?${new URLSearchParams({ agent: agentId, version: String(version) }).toString()}`;
}

/**
 * A fresh session on `agent`, carrying nothing over. `key` must be a number the caller has not used
 * before for this composer; {@link selectAgent} supplies `previous.key + 1`.
 */
export function startSession(agent: ComposerAgent, key: number): ComposerSession {
  return { key, agentId: agent.id, files: [], connectors: [] };
}

function isRunnable(agent: ComposerAgent): boolean {
  return agent.runTarget.kind === 'runnable';
}

/**
 * The agent the composer selects before the user chooses one (issue #393).
 *
 * The agent list is oldest first, and the oldest agent is the seeded "General", which inherits the
 * workspace default model rather than naming one — so taking the first agent ran the first message
 * on whatever the workspace default happened to be, not on the agent the setup wizard had just
 * configured and tested. The order of preference is therefore:
 *
 * 1. the agent this user last sent a message as (`rememberedAgentId`), if it can still run;
 * 2. the agent first-run setup configured (`setupAgentId`, marked on the agent at setup), if it can run;
 * 3. the first agent that can run on a model of its **own**;
 * 4. the first agent that can run at all;
 * 5. the remembered agent, the setup agent, then the first agent — so the screen still opens on
 *    something, and the composer says why it cannot run rather than hiding the agent.
 *
 * Steps 3 to 5 skip a built-in agent such as the Builder (#2012): every workspace has one, so it is
 * never the default unless it was remembered or is the only agent listed.
 */
export function preferredAgent(
  agents: readonly ComposerAgent[],
  rememberedAgentId: unknown,
  setupAgentId: string | null = null,
): ComposerAgent | null {
  const remembered = findAgent(agents, rememberedAgentId);
  if (remembered !== null && isRunnable(remembered)) return remembered;
  const setup = findAgent(agents, setupAgentId);
  if (setup !== null && isRunnable(setup)) return setup;
  const own = agents.filter((agent) => agent.builtin === undefined);
  return (
    own.find(
      (agent) => agent.runTarget.kind === 'runnable' && agent.runTarget.source === 'agent',
    ) ??
    own.find(isRunnable) ??
    remembered ??
    setup ??
    own[0] ??
    // Only a built-in agent is listed: open on it, because a screen with no session disables the picker.
    agents[0] ??
    null
  );
}

/**
 * The session the screen opens with: {@link preferredAgent}'s choice, or `null` when the workspace
 * has none. `null` is the honest answer for "there is nothing to run this message as" — it is never
 * substituted with a placeholder agent.
 */
export function initialSession(
  agents: readonly ComposerAgent[],
  rememberedAgentId: unknown = null,
  setupAgentId: string | null = null,
): ComposerSession | null {
  const chosen = preferredAgent(agents, rememberedAgentId, setupAgentId);
  return chosen === null ? null : startSession(chosen, 0);
}

/** What a run of `agent` would use when the composer files it under `projectId` (or none). */
export function runTargetIn(agent: ComposerAgent, projectId: string | null): ComposerRunTarget {
  return (
    (projectId === null ? undefined : agent.runTargetByProject?.[projectId]) ?? agent.runTarget
  );
}

/**
 * Whether no per-message model override can make `target` runnable: the agent has no usable
 * runtime profile, and a runtime has no override layer (#403 follow-up).
 */
function overrideCannotFix(target: ComposerRunTarget): boolean {
  return target.kind === 'unrunnable' && target.code === 'agent_runtime_profile_missing';
}

/**
 * Why a first message filed under `projectId` must not be sent, or `null` (PR #403 review).
 *
 * The composer opens a project's session (`POST /api/projects/:id/sessions`) before it starts the
 * run, so a start the server will refuse would leave that session behind. When the run target in
 * that project already says the agent cannot run, the composer says so instead and opens nothing.
 * A per-message model override can still fix a model problem, so only a missing runtime profile —
 * which no override fixes — refuses a message that carries one.
 */
export function projectStartRefusal(
  agent: ComposerAgent,
  projectId: string | null,
  hasOverride: boolean,
): { readonly code: string; readonly reason: string } | null {
  if (projectId === null) return null;
  const target = runTargetIn(agent, projectId);
  if (target.kind !== 'unrunnable') return null;
  if (hasOverride && !overrideCannotFix(target)) return null;
  return { code: target.code, reason: target.reason };
}

const SOURCE_LABEL: Readonly<
  Record<Extract<ComposerRunTarget, { kind: 'runnable' }>['source'], string>
> = {
  agent: 'the agent’s model',
  project: 'the project default',
  workspace: 'the workspace default',
  deployment: 'the deployment default',
};

/** Whether the run-target line is a warning: the agent cannot run, and no override fixes that. */
export function runTargetWarns(target: ComposerRunTarget, hasOverride: boolean): boolean {
  return target.kind === 'unrunnable' && (!hasOverride || overrideCannotFix(target));
}

/**
 * The line under the composer that says what **Send** will run (issue #393): the agent, the model
 * and where the model comes from — the run override when one is chosen, otherwise the run ladder:
 * the agent's own model, then the selected project's default, then the workspace default. For an
 * agent that cannot run, the reason instead — even with an override, when the override cannot fix
 * it (a missing runtime profile).
 */
export function runTargetLine(
  agent: ComposerAgent,
  override: { readonly connectionName: string; readonly model: string } | null,
  projectId: string | null = null,
): string {
  const target = runTargetIn(agent, projectId);
  if (override !== null && !overrideCannotFix(target)) {
    return `Runs as ${agent.name} on ${override.model} (${override.connectionName}, this message only).`;
  }
  switch (target.kind) {
    case 'runnable':
      // The deployment default is a configured id the description does not check with the
      // provider, and a run on a list of dated releases only uses the newest of them (#506).
      return `Runs as ${agent.name} on ${target.model}${
        target.source === 'deployment' ? ' or its newest dated release' : ''
      } (${target.connectionName}, ${SOURCE_LABEL[target.source]}).`;
    case 'unrunnable':
      return `${agent.name} cannot run yet — ${target.reason}`;
    case 'unknown':
      return `Runs as ${agent.name}.`;
    default: {
      const unknown: never = target;
      throw new TypeError(`no run target of kind ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * Where the composer remembers the last agent a user sent a message as: per workspace and per user
 * id (PR #403 review). The user's id, not their sign-in subject, so no email address is written to
 * browser storage, and the workspace, so one browser shared across workspaces keeps them apart.
 */
export function lastAgentStorageKey(workspaceId: string, userId: string): string {
  return `agent-workspace.composer.last-agent:${workspaceId}:${userId}`;
}

/** What {@link selectAgent} and {@link toggleOption} produce. Never both branches, never neither. */
export type ComposerUpdate =
  | { readonly ok: true; readonly session: ComposerSession; readonly newSession: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * §19.5.1 rule 4. Choosing a different agent **starts a new session**: a new key, and no files or
 * connectors carried over. Choosing the agent that is already selected is not a switch and does not
 * start one — re-opening the picker and clicking the current row must not silently discard a
 * selection the user made.
 *
 * An id no agent in `agents` carries is refused by name. It is not treated as "keep the current
 * agent", because a caller that asked to switch and was quietly not switched would go on to send
 * the message to an agent it did not choose.
 */
export function selectAgent(
  agents: readonly ComposerAgent[],
  session: ComposerSession,
  agentId: unknown,
): ComposerUpdate {
  const next = findAgent(agents, agentId);
  if (next === null) {
    return {
      ok: false,
      reason: `no agent with id ${JSON.stringify(agentId)} is available to this workspace`,
    };
  }
  if (next.id === session.agentId) return { ok: true, session, newSession: false };
  return { ok: true, session: startSession(next, session.key + 1), newSession: true };
}

/**
 * §19.5.1 rule 2. Add or remove one file or connector for this session.
 *
 * `optionId` is accepted because {@link offeredBy} was searched and the option was **found** on the
 * selected agent. An id the agent does not carry is refused and named — including one a stale
 * render, a restored draft or a hand-crafted event might supply — so the selection can never name a
 * capability the agent lacks. That is the narrowing invariant enforced on the write, rather than
 * hoped for on the read.
 *
 * `agent` must be the agent `session` names; a mismatch is refused rather than silently trusted,
 * because narrowing against the wrong agent's permissions is exactly the failure rule 2 forbids.
 */
export function toggleOption(
  agent: ComposerAgent,
  session: ComposerSession,
  kind: PickerKind,
  optionId: unknown,
): ComposerUpdate {
  if (agent.id !== session.agentId) {
    return {
      ok: false,
      reason: `session runs as ${JSON.stringify(session.agentId)} but was narrowed against ${JSON.stringify(agent.id)}`,
    };
  }
  if (typeof optionId !== 'string' || optionId === '') {
    return { ok: false, reason: `${JSON.stringify(optionId)} is not an option id` };
  }

  const permitted = offeredBy(agent, kind).some((option) => option.id === optionId);
  if (!permitted) {
    return {
      ok: false,
      reason: `agent ${JSON.stringify(agent.name)} does not permit the ${kind} option ${JSON.stringify(optionId)}`,
    };
  }

  const current = selectedIn(session, kind);
  const next = current.includes(optionId)
    ? current.filter((id) => id !== optionId)
    : [...current, optionId];

  return {
    ok: true,
    session: kind === 'files' ? { ...session, files: next } : { ...session, connectors: next },
    newSession: false,
  };
}

/**
 * The chip row above the pickers: one chip per selected option, in the order the agent lists them.
 *
 * Derived from the agent's own options, so a chip can only ever name something the agent permits. A
 * selected id the agent does not carry contributes no chip — it cannot arise through
 * {@link toggleOption}, and if it arises another way the screen shows fewer chips rather than naming
 * a capability that is not there.
 */
export function selectedChips(
  agent: ComposerAgent,
  session: ComposerSession,
): readonly PickerOption[] {
  if (agent.id !== session.agentId) return [];
  const chips: PickerOption[] = [];
  for (const kind of ['files', 'connectors'] as const) {
    const selected = selectedIn(session, kind);
    for (const option of offeredBy(agent, kind)) {
      if (selected.includes(option.id)) chips.push(option);
    }
  }
  return chips;
}
