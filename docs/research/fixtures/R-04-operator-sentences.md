# R-04 operator sentences

The operator-facing approximation sentences the OpenAI provider adapter must emit verbatim; `packages/gateway/src/providers/openai.test.ts` pins `OPENAI_APPROXIMATION_WARNINGS` to these lines.

Operator sentence: *"This model receives your system prompt as a single block of text, not as separately cached, individually managed pieces — the platform still sends the prompt, but the fine-grained caching and prompt structure you set for Claude does not carry over."*

Operator sentence: *"Tool definitions are sent as plain JSON Schema; you cannot mark an individual tool as a fixed cache boundary the way you can with Claude, so changing your tool list may invalidate more of the cached prompt than it would on Claude."*

Operator sentence: *"This model returns tool-call arguments as raw text you must parse into JSON yourself, rather than as a ready-made structured object."*

Operator sentence: *"Whether a tool call succeeded or failed is not a separate flag for this model — it is judged from the wording of the tool's output text, so a tool that fails silently (empty or ambiguous output) will not be recognized as an error the way it would with Claude."*

Operator sentence: *"Streaming updates arrive under this provider's own event names and grouping, not Claude's — the platform translates them, so what you see should look the same, but a tool inspecting the raw event stream will see different event types than it would with Claude."*

Operator sentence for those two: *"If this provider's connection fails part-way through a reply, the platform has to reconstruct the error rather than pass it along, and a reply cut short by the provider can look complete — check the response's stop reason before treating a short answer as the model's final word."*

Operator sentence (for the §12 warning; this is the load-bearing one for the whole element, since `stop_reason` is checked by almost every caller): *"This model does not report a single reason your conversation stopped the way Claude does — the platform infers it from the shape of the response, a refusal from this model looks like a normal completed answer unless you read the message content closely, and stop sequences you configured are not enforced by the model itself at all."*

Operator sentence: *"Usage reporting is close but not identical: this provider doesn't distinguish a short-lived cache from a long-lived one the way Claude does, and it doesn't report web-search or web-fetch call counts inside the usage totals."*

Operator sentence: *"Some failures from this model arrive as a completed response marked failed, rather than as an error the platform can pass straight through — the platform converts these for you, but the underlying failure code is provider-specific and not one of Claude's own error types."*

Operator sentence: *"This model's reasoning is hidden by default — you can request a short paraphrased summary instead of the reasoning itself, and the full reasoning is only preserved across turns as an opaque token, not as readable text the way Claude's thinking can be."*

