import { archiveProject } from '../../../../../server/projects/lifecycle';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** issue #183. The handler, its concealment rule and its audit rule are in `lifecycle.ts`. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return archiveProject(request, id);
}
