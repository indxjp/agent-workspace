// GET /api/tickets/:id/history: the ticket's audit rows, oldest first. Each names who wrote, in
// person or through an agent, which fields, and the run an agent wrote in; never a value. A person
// who may not read the ticket gets the ticket route's own 404.
// shortcut: its own small pool, as the app kit's runtime lends none; upgrade when it reads history.
import ticket from '@/resources/ticket';
import { AppStoreError, appAuditTable } from '@indx-workspace/app/db';
import { appRuntime, currentPerson, fromStoreError, problem } from '@indx-workspace/app/server';
import { and, asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';

let db: ReturnType<typeof drizzle> | undefined;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const runtime = appRuntime();
    const person = await currentPerson(request);
    if (person === null) return problem('unauthenticated', 401, 'Sign in to use this app.');
    const { id } = await context.params;
    await runtime.storeOf(ticket).get(person, id);
    db ??= drizzle({ connection: { connectionString: process.env['DATABASE_URL'], max: 2 } });
    const audit = appAuditTable(runtime.appName);
    const items = await db
      .select()
      .from(audit)
      .where(
        and(
          eq(audit.workspace_id, person.workspaceId),
          eq(audit.resource, ticket.name),
          eq(audit.record_id, id),
        ),
      )
      .orderBy(asc(audit.at), asc(audit.id))
      .limit(200);
    return Response.json({ items }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof AppStoreError) return fromStoreError(error);
    return problem('internal_error', 500, 'The ticket history could not be read.');
  }
}
