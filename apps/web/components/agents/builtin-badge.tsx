import type { AgentResource } from '../../contracts/agents';

/** The "Built-in" pill beside the name of a platform-provided agent; nothing for any other. */
export function BuiltinBadge({ builtin }: { readonly builtin: AgentResource['builtin'] }) {
  if (builtin === undefined) return null;
  return (
    <span className="ml-2 rounded-full border border-border-strong bg-surface px-2 py-0.5 text-[11px] font-medium text-muted">
      Built-in
    </span>
  );
}
