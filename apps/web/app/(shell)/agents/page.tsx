/**
 * `/agents` — spec §17, §34, §46. The seam between the route and `components/agents/agents-list.tsx`,
 * which does the fetching and the layout; see that file's header for what this screen shows and why.
 */
import { AgentsListScreen } from '../../../components/agents/agents-list';

export default function AgentsPage() {
  return <AgentsListScreen />;
}
