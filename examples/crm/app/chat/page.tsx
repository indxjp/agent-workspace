import { appRuntime } from '@indx-workspace/app/server';

import { SignInRequired } from '../notices';
import { personClient } from '../portal';
import { strings } from '../strings';
import { ChatPanel } from './chat-panel';

export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  if ((await personClient()) === null) return <SignInRequired next="/chat" />;
  return (
    <main>
      <h1>{strings.chatTitle}</h1>
      <ChatPanel baseUrl={appRuntime().awUrl} />
    </main>
  );
}
