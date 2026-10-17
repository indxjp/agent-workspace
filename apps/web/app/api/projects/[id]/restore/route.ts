import { restoreProject } from '../../../../../server/projects/lifecycle';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** issue #183. The inverse of `../archive/route.ts`; both share one handler in `lifecycle.ts`. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return restoreProject(request, id);
}
