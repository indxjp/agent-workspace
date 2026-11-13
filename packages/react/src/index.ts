/**
 * `@indx-workspace/react`: the hosted surface chat as a component, `<Chat/>`, with its message
 * list, message, composer and tool result replaceable through `components`, and its state as a
 * hook, `useConversation()`, for a page that draws everything itself (issue #623). The tool
 * trace and the attachment chips are exported as parts, so another chat (the console's composer,
 * an app's agent panel) draws the same ones (R-F5a, issue #1489); `prepareAttachment` shrinks a
 * large photo before an upload, for an app's channel composer too (issue #1519).
 */
export {
  Chat,
  type ChatComponents,
  type ChatProps,
  type ComposerProps,
  type MessageListProps,
  type MessageProps,
  sendsOnEnter,
} from './surface-chat.js';
export { AssistantProse } from './assistant-prose.js';
export { prepareAttachment } from './attachment-image.js';
export {
  ApprovalPrompt,
  type ApprovalPromptProps,
  type ApprovalPromptStrings,
} from './approval-prompt.js';
export type { ToolResultProps } from './parts.js';
export {
  AttachmentChips,
  ToolTrace,
  type AttachmentChipsProps,
  type ToolTraceProps,
} from './parts.js';
export {
  useConversation,
  type Conversation,
  type ConversationStatus,
  type UseConversationOptions,
} from './use-conversation.js';
export type { Message, Speaker } from './run-model.js';
export { SURFACE_DEFAULTS } from './theme.js';
