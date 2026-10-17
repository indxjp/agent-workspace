/**
 * `@indx-workspace/react`: the hosted surface chat as a component, `<Chat/>`, with its message
 * list, message, composer and tool result replaceable through `components`, and its state as a
 * hook, `useConversation()`, for a page that draws everything itself (issue #623).
 */
export {
  Chat,
  type ChatComponents,
  type ChatProps,
  type ComposerProps,
  type MessageListProps,
  type MessageProps,
} from './surface-chat.js';
export { AssistantProse } from './assistant-prose.js';
export type { ToolResultProps } from './parts.js';
export {
  useConversation,
  type Conversation,
  type ConversationStatus,
  type UseConversationOptions,
} from './use-conversation.js';
export type { Message, Speaker } from './run-model.js';
export { SURFACE_DEFAULTS } from './theme.js';
