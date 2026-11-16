import { deskStartRunningRun } from '../../../../server/desk';

/**
 * The desk's test hook (issue #1522): starts a run in `running` on the scripted Agent Workspace,
 * as a person starting an agent somewhere else would, so the dashboard journey can watch it
 * appear. Only the fixture has it; no app does.
 */
export async function POST(): Promise<Response> {
  const run = await deskStartRunningRun();
  return Response.json({ id: run.id }, { status: 201, headers: { 'cache-control': 'no-store' } });
}
