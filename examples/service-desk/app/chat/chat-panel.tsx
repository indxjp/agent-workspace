'use client';
// shortcut: the chat opens the project's `main` surface on Agent Workspace's own origin, which
// answers a page on the app's origin once the run routes answer CORS (#623); until then put both
// behind one origin. Upgrade to a chat run as the signed-in person when the portal's sign-in lands.
import { Chat } from '@indx-workspace/react';

/** The project's `main` surface, in the portal's page. */
export function ChatPanel({ baseUrl }: { readonly baseUrl: string }) {
  return <Chat surface="main" baseUrl={baseUrl} />;
}
