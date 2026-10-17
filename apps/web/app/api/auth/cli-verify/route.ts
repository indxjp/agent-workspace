/**
 * `/api/auth/cli-verify` — issue #242 (SDK-10, S-22): the page where a signed-in person approves
 * or denies the code `aw login` printed. ADR-0083. See `server/cli-auth/verify-page.ts`.
 */
import { renderVerifyPage, submitVerifyPage } from '../../../../server/cli-auth/verify-page';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  return renderVerifyPage(request);
}

export function POST(request: Request): Promise<Response> {
  return submitVerifyPage(request);
}
