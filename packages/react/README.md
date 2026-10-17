# @indx-workspace/react

The hosted surface chat as React. `<Chat/>` is the chat `GET /p/s/<name>` renders, with its
message list, message, composer and tool result each replaceable; `useConversation()` is the same
conversation without any markup. `react` (19) is a peer dependency; the transport is
[`@indx-workspace/sdk`](https://www.npmjs.com/package/@indx-workspace/sdk).

```tsx title="illustrative" claim="illustrative"
import { Chat, useConversation } from '@indx-workspace/react';

<Chat surface="main" baseUrl="https://agents.example.com" components={{ Composer: MyComposer }} />;

// or fully headless:
const { messages, send, status } = useConversation({ surface: 'main', baseUrl });
```

Import the stylesheet once, `import '@indx-workspace/react/styles.css'`. Under `aw dev` the local
draft of a surface admits pages on `http://localhost:*` and `http://127.0.0.1:*` while it lists no
`allowedOrigins` of its own, so a dev server
needs no CORS setup. The guide is [Your own React](https://docs.agentworkspace.indx.jp/building/react).

## `<Chat/>`

| Prop         | Type                                                 | Meaning                                                                                       |
| ------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `surface`    | `string`                                             | The surface's name, as in `/p/s/<name>`.                                                      |
| `agentName`  | `string?`                                            | The surface's own agent. Defaults to `definition.agent`, then to `surface`.                   |
| `definition` | `SurfaceDefinition?`                                 | What `defineSurface` returns: the title, theme, layout and parts. Absent is the default look. |
| `baseUrl`    | `string?`                                            | The Agent Workspace (or a proxy of it; a path prefix is kept). Defaults to the page's origin. |
| `notice`     | `ReactNode?`                                         | A row inside the frame, above the header.                                                     |
| `components` | `{ MessageList?, Message?, Composer?, ToolResult? }` | Parts to draw instead of the defaults.                                                        |

Each part receives the props its exported type declares, and nothing else:

| Part          | Props type         | Props                                                                                  |
| ------------- | ------------------ | -------------------------------------------------------------------------------------- |
| `MessageList` | `MessageListProps` | `children`: the messages.                                                              |
| `Message`     | `MessageProps`     | `message`; `tools` and `feedback`, the nodes to draw before and after it (or `null`).  |
| `Composer`    | `ComposerProps`    | `value`, `onChange(value)`, `onSubmit()`, `disabled`, `canSend`, `label`, `sendLabel`. |
| `ToolResult`  | `ToolResultProps`  | `output` (the tool's raw output) and `component` (`table`, `card` or `text`).          |

## `useConversation()`

Takes the same `surface`, `agentName`, `definition` and `baseUrl`, and returns `messages`, `status`
(`'idle' | 'restoring' | 'sending' | 'ended'`), `runStatus` (the last run's badge), `failure`,
`turns` (each run's tool steps), `send(prompt)`, `rate(runId, rating)`, `rated`, `failedRatings`,
`agentName`, `agents` and `switchAgent(agent)`. A surface's `429` refusals come back as `failure`;
at the turn limit `status` is `ended`.

## What it does not do yet

- **A proxy for an origin the surface does not list.** `baseUrl` points the chat at a deployed
  Agent Workspace (an `http:` or `https:` URL; anything else throws). The session bootstrap and the
  four visitor run routes (`/api/agents/:id/runs`, `/api/runs/:id`, `/api/runs/:id/events`,
  `/api/runs/:id/feedback`) answer a page on one of the surface's `allowedOrigins`, with no
  credentials. The list in force is the served version's: `production` once the agent is promoted,
  so an origin added to the draft later needs `aw promote` first. For any other origin, serve the
  page from the workspace's origin, or proxy `/p/s/*` and `/api/*` to it and set `baseUrl` to the
  proxy. No cookie is ever sent to another origin.
- **Your own theme beyond the surface's.** The default look is `@indx-workspace/react/styles.css`
  (import it once); it is plain CSS driven by the theme's custom properties. To change more than
  the theme, override the `aw-*` class names or replace the parts.
