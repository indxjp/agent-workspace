/**
 * `/agents/new` — spec §17, §46's "enter instructions → select Claude" step. The seam between the
 * route and `components/agents/agent-form.tsx`; see that file's header and `components/agents/model.ts`
 * for what this screen asks for and why it is not the full five-step wizard.
 */
import { NewAgentScreen } from '../../../../components/agents/agent-form';

export default function NewAgentPage() {
  return <NewAgentScreen />;
}
