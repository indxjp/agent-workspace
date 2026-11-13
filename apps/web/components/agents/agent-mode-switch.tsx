'use client';

/** The new-agent form and its form/chat mode entry point. */

import { type KeyboardEvent } from 'react';

export const AGENT_MODES = ['form', 'chat'] as const;

export type AgentMode = (typeof AGENT_MODES)[number];

/** The switch's words in the reader's language. */
export interface AgentModeWords {
  readonly label: string;
  readonly modes: Readonly<Record<AgentMode, string>>;
}

const EN_MODE_WORDS: AgentModeWords = {
  label: 'How to create this agent',
  modes: { form: 'Form', chat: 'Chat' },
};

/** `?mode=chat` selects Chat only when the feature is on; anything else is the form. */
export function parseAgentMode(param: string | null, chatEnabled: boolean): AgentMode {
  return chatEnabled && param === 'chat' ? 'chat' : 'form';
}

const ARROW_STEPS: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/** The option an arrow, Home or End key moves to (wrapping), or `null` for any other key. */
export function nextAgentMode(current: AgentMode, key: string): AgentMode | null {
  if (key === 'Home') return AGENT_MODES[0];
  if (key === 'End') return AGENT_MODES[AGENT_MODES.length - 1] ?? null;
  const step = ARROW_STEPS[key];
  if (step === undefined) return null;
  const count = AGENT_MODES.length;
  return AGENT_MODES[(AGENT_MODES.indexOf(current) + step + count) % count] ?? null;
}

export function AgentModeSwitch({
  mode,
  onChange,
  words = EN_MODE_WORDS,
}: Readonly<{ mode: AgentMode; onChange: (mode: AgentMode) => void; words?: AgentModeWords }>) {
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: AgentMode) {
    const next = nextAgentMode(current, event.key);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    document.getElementById(`agent-mode-${next}`)?.focus();
  }
  return (
    <div
      role="radiogroup"
      aria-label={words.label}
      className="mb-4 inline-flex rounded-(--radius-sm) border border-border-strong p-0.5"
    >
      {AGENT_MODES.map((option) => (
        <button
          key={option}
          id={`agent-mode-${option}`}
          type="button"
          role="radio"
          aria-checked={option === mode}
          tabIndex={option === mode ? 0 : -1}
          onClick={() => onChange(option)}
          onKeyDown={(event) => onKeyDown(event, option)}
          className={`h-7 rounded-(--radius-sm) px-3 text-[13px] ${
            option === mode ? 'bg-accent-soft font-semibold' : 'text-muted'
          }`}
        >
          {words.modes[option]}
        </button>
      ))}
    </div>
  );
}
