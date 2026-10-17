/**
 * `/workspaces` — issue #120's one route: the directory, the create form and the settings form,
 * transcribed from `ui/workspaces.html`. See `workspaces-screen.tsx` for what this screen shows
 * and why it fetches from the browser rather than reading a store server-side.
 */
import { WorkspacesScreen } from './workspaces-screen';

export const dynamic = 'force-dynamic';

export default function WorkspacesPage() {
  return <WorkspacesScreen />;
}
