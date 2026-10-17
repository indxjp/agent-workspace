/**
 * The parts a hosted surface shows (ADR-0108 rungs ① and ②; ADR-0105; S1-18, issue #456): the
 * header with the logo and title, the greeting and suggested prompts of an empty conversation,
 * the disclaimer, and the tool trace; and since issue #540 (ADR-0108 SD10) the full trace, tool
 * results as a card or a table, the agent switcher and the feedback buttons. Each is
 * presentational; `./surface-chat.tsx` decides when each shows and owns the one chat composer.
 */
import type { ReactNode } from 'react';

import { RUN_FEEDBACK_RATINGS, type RunFeedbackRating } from '@indx-workspace/contracts/feedback';
import type {
  SurfaceLogo,
  SurfaceToolResultComponent,
  SurfaceToolTraceMode,
} from '@indx-workspace/contracts/surfaces';

import type { SurfaceStrings } from './locale.js';
import type { SurfaceToolStep } from './surface-chat-model.js';

export interface SurfaceHeaderProps {
  readonly logo?: SurfaceLogo | undefined;
  readonly title?: string | undefined;
  readonly agentName: string;
}

/** The logo, as a text mark or an image, and the surface's title or else its agent's name. */
export function SurfaceHeader({ logo, title, agentName }: SurfaceHeaderProps): ReactNode {
  return (
    <header className="aw-header">
      {logo === undefined ? null : 'text' in logo ? (
        <span className="aw-logo">{logo.text}</span>
      ) : (
        <img src={logo.url} alt="" referrerPolicy="no-referrer" className="aw-logo-image" />
      )}
      <h1 className="aw-title">{title ?? agentName}</h1>
    </header>
  );
}

/** The greeting shown while the conversation is empty. */
export function SurfaceGreeting({ text }: { readonly text: string }): ReactNode {
  return <p className="aw-greeting">{text}</p>;
}

export interface SuggestedPromptsProps {
  readonly prompts: readonly string[];
  readonly label: string;
  readonly disabled: boolean;
  readonly onPick: (prompt: string) => void;
}

/** One button per suggested prompt; picking one sends it. */
export function SuggestedPrompts({
  prompts,
  label,
  disabled,
  onPick,
}: SuggestedPromptsProps): ReactNode {
  return (
    <div className="aw-prompts" role="group" aria-label={label}>
      {prompts.map((prompt) => (
        <button
          key={prompt}
          type="button"
          className="aw-prompt"
          disabled={disabled}
          onClick={() => {
            onPick(prompt);
          }}
        >
          {prompt}
        </button>
      ))}
    </div>
  );
}

/** The surface's disclaimer, a note under the conversation. */
export function SurfaceDisclaimer({
  text,
  label,
}: {
  readonly text: string;
  readonly label: string;
}): ReactNode {
  return (
    <aside className="aw-disclaimer" aria-label={label}>
      {text}
    </aside>
  );
}

export interface ToolTraceProps {
  readonly mode: SurfaceToolTraceMode;
  readonly steps: readonly SurfaceToolStep[];
  readonly strings: Pick<SurfaceStrings, 'toolActivity' | 'toolInput' | 'toolOutput'>;
}

function stepState(step: SurfaceToolStep): 'running' | 'error' | 'done' {
  if (step.output === null) return 'running';
  return step.isError ? 'error' : 'done';
}

const STEP_MARKS = { running: '◌', error: '✕', done: '✓' } as const;

/**
 * The agent's tool steps: nothing when `hidden` (or when there are none), a closed disclosure
 * with the localised count when `collapsed`, and an open one with each step's input and output
 * when `full`. Everything is a text node, so a tool's output cannot inject markup.
 */
export function ToolTrace({ mode, steps, strings }: ToolTraceProps): ReactNode {
  if (mode === 'hidden' || steps.length === 0) return null;
  const full = mode === 'full';
  return (
    <details className="aw-trace" open={full}>
      <summary className="aw-trace-summary">{strings.toolActivity(steps.length)}</summary>
      <ul className="aw-trace-steps">
        {steps.map((step) => (
          <li key={step.id} className="aw-trace-step" data-state={stepState(step)}>
            <span aria-hidden="true">{STEP_MARKS[stepState(step)]}</span>
            <span className="aw-mono">{step.name}</span>
            {full ? (
              <dl className="aw-trace-detail">
                <dt>{strings.toolInput}</dt>
                <dd>
                  <pre className="aw-pre">{JSON.stringify(step.input, null, 2)}</pre>
                </dd>
                {step.output === null ? null : (
                  <>
                    <dt>{strings.toolOutput}</dt>
                    <dd>
                      <pre className="aw-pre">{step.output}</pre>
                    </dd>
                  </>
                )}
              </dl>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** How one tool's output renders: the component it asked for when the output fits, else text. */
export type ToolResultView =
  | {
      readonly kind: 'table';
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
    }
  | { readonly kind: 'card'; readonly entries: readonly (readonly [string, string])[] }
  | { readonly kind: 'text'; readonly text: string };

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsedJson(output: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return undefined;
  }
}

function cellText(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Read `output` as `component` asks: a `table` from a non-empty JSON array of objects (the columns
 * are every key, in first-seen order), a `card` from a JSON object, and text in every other case,
 * invalid JSON included.
 */
export function toolResultView(
  output: string,
  component: SurfaceToolResultComponent,
): ToolResultView {
  const text: ToolResultView = { kind: 'text', text: output };
  if (component === 'text') return text;
  const value = parsedJson(output);
  if (component === 'card') {
    return isPlainObject(value)
      ? { kind: 'card', entries: Object.entries(value).map(([key, each]) => [key, cellText(each)]) }
      : text;
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every(isPlainObject)) return text;
  const columns = [...new Set(value.flatMap((row) => Object.keys(row)))];
  return {
    kind: 'table',
    columns,
    rows: value.map((row) => columns.map((column) => cellText(row[column]))),
  };
}

/** One finished tool step's result: its raw output, and the component `toolResults` names. */
export interface ToolResultProps {
  readonly output: string;
  readonly component: SurfaceToolResultComponent;
}

/** One tool's result, as `toolResults` names its component. */
export function ToolResult({ output, component }: ToolResultProps): ReactNode {
  const view = toolResultView(output, component);
  switch (view.kind) {
    case 'table':
      return (
        <table className="aw-table">
          <thead>
            <tr>
              {view.columns.map((column) => (
                <th key={column} className="aw-th">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, column) => (
                  <td key={column} className="aw-td">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'card':
      return (
        <dl className="aw-card">
          {view.entries.map(([key, value]) => (
            <div key={key} className="aw-card-row">
              <dt className="aw-card-key">{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      );
    case 'text':
      return <pre className="aw-pre aw-result-text">{view.text}</pre>;
  }
}

export interface AgentSwitcherProps {
  readonly agents: readonly string[];
  readonly current: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly onSwitch: (agent: string) => void;
}

/** The agents a visitor may talk to, as a native select. */
export function AgentSwitcher({
  agents,
  current,
  label,
  disabled,
  onSwitch,
}: AgentSwitcherProps): ReactNode {
  return (
    <select
      aria-label={label}
      className="aw-switcher"
      value={current}
      disabled={disabled}
      onChange={(event) => {
        onSwitch(event.target.value);
      }}
    >
      {agents.map((agent) => (
        <option key={agent} value={agent}>
          {agent}
        </option>
      ))}
    </select>
  );
}

export interface FeedbackButtonsProps {
  readonly rated: RunFeedbackRating | null;
  readonly failed: boolean;
  readonly strings: Pick<SurfaceStrings, 'feedbackUp' | 'feedbackDown' | 'feedbackFailed'>;
  readonly onRate: (rating: RunFeedbackRating) => void;
}

const RATING_MARKS = { up: '👍', down: '👎' } as const;

/** A thumbs-up and a thumbs-down on one answer; both are disabled once it is rated. */
export function FeedbackButtons({
  rated,
  failed,
  strings,
  onRate,
}: FeedbackButtonsProps): ReactNode {
  const labels = { up: strings.feedbackUp, down: strings.feedbackDown } as const;
  return (
    <div className="aw-feedback">
      {RUN_FEEDBACK_RATINGS.map((rating) => (
        <button
          key={rating}
          type="button"
          aria-label={labels[rating]}
          aria-pressed={rated === rating}
          disabled={rated !== null}
          className="aw-rating"
          onClick={() => {
            onRate(rating);
          }}
        >
          {RATING_MARKS[rating]}
        </button>
      ))}
      {failed ? <span role="status">{strings.feedbackFailed}</span> : null}
    </div>
  );
}
