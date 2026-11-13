export const OPENAI_APPROXIMATION_WARNINGS = {
  'system instructions':
    'This model receives your system prompt as a single block of text, not as separately cached, individually managed pieces — the platform still sends the prompt, but the fine-grained caching and prompt structure you set for Claude does not carry over.',
  'tool definitions':
    'Tool definitions are sent as plain JSON Schema; you cannot mark an individual tool as a fixed cache boundary the way you can with Claude, so changing your tool list may invalidate more of the cached prompt than it would on Claude.',
  'tool calls':
    'This model returns tool-call arguments as raw text you must parse into JSON yourself, rather than as a ready-made structured object.',
  'tool results':
    "Whether a tool call succeeded or failed is not a separate flag for this model — it is judged from the wording of the tool's output text, so a tool that fails silently (empty or ambiguous output) will not be recognized as an error the way it would with Claude.",
  streaming:
    "Streaming updates arrive under this provider's own event names and grouping, not Claude's — the platform translates them, so what you see should look the same, but a tool inspecting the raw event stream will see different event types than it would with Claude.",
  'stop reasons':
    'This model does not report a single reason your conversation stopped the way Claude does — the platform infers it from the shape of the response, a refusal from this model looks like a normal completed answer unless you read the message content closely, and stop sequences you configured are not enforced by the model itself at all.',
  usage:
    "Usage reporting is close but not identical: this provider doesn't distinguish a short-lived cache from a long-lived one the way Claude does, and it doesn't report web-search or web-fetch call counts inside the usage totals.",
  errors:
    "Some failures from this model arrive as a completed response marked failed, rather than as an error the platform can pass straight through — the platform converts these for you, but the underlying failure code is provider-specific and not one of Claude's own error types.",
  'reasoning/thinking':
    "This model's reasoning is hidden by default — you can request a short paraphrased summary instead of the reasoning itself, and the full reasoning is only preserved across turns as an opaque token, not as readable text the way Claude's thinking can be.",
} as const;

export const OPENAI_CANNOT_REPRESENT = [
  'stop_sequences and stop_reason:stop_sequence',
  'tool_result.is_error',
  'pause_turn',
  'model_context_window_exceeded as a post-hoc condition',
  'Anthropic refusal category taxonomy',
  'dual 5m/1h cache TTL and split',
  'verbatim continuous visible reasoning text',
] as const;

export const OPENAI_TRANSLATION_TABLE = [
  {
    element: 'system instructions',
    verdict: 'approximated',
    warning: OPENAI_APPROXIMATION_WARNINGS['system instructions'],
  },
  { element: 'user messages', verdict: 'lossless' },
  { element: 'assistant messages', verdict: 'lossless' },
  {
    element: 'text content blocks',
    verdict: 'lossless',
    caveat: 'citations use a provider-specific shape',
  },
  {
    element: 'tool definitions',
    verdict: 'approximated',
    warning: OPENAI_APPROXIMATION_WARNINGS['tool definitions'],
  },
  {
    element: 'tool calls',
    verdict: 'approximated',
    warning: OPENAI_APPROXIMATION_WARNINGS['tool calls'],
  },
  {
    element: 'tool results',
    verdict: 'approximated',
    warning: OPENAI_APPROXIMATION_WARNINGS['tool results'],
    cannotRepresent: ['tool_result.is_error'],
  },
  {
    element: 'streaming',
    verdict: 'approximated',
    warning: OPENAI_APPROXIMATION_WARNINGS.streaming,
  },
  {
    element: 'stop reasons',
    verdict: 'approximated',
    warning: OPENAI_APPROXIMATION_WARNINGS['stop reasons'],
    cannotRepresent: ['stop_sequences', 'pause_turn', 'model_context_window_exceeded'],
  },
  { element: 'usage', verdict: 'approximated', warning: OPENAI_APPROXIMATION_WARNINGS.usage },
  { element: 'errors', verdict: 'approximated', warning: OPENAI_APPROXIMATION_WARNINGS.errors },
  {
    element: 'reasoning/thinking where a meaningful mapping exists',
    verdict: 'approximated',
    warning: OPENAI_APPROXIMATION_WARNINGS['reasoning/thinking'],
  },
] as const;
