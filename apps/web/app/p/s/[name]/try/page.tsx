/**
 * `GET /p/s/<name>/try` — try the one-tag widget (ADR-0105 slice 1; S1-18, issue #456). Served
 * exactly where the surface page and its loader are: `readSurfacePage` checks ADR-0105's
 * conditions 1–3, the name and the `local` pointer, and anything it refuses is the page's `404`.
 * It is the surface's full-height chat, or one card with the key fix when no key is set. It
 * always serves `local`, the working draft, on loopback only, and notes when the agent has no
 * `production` pointer yet, so the public is served the same draft (issue #612). It runs the
 * first message's run preflight on load, so a model connection that is missing, rejected or cannot
 * be connected to is said, with its fix, before anything is sent (issue #661).
 * The printed tag names the origin the page was asked on; conditions 1–3 have held, so that is a
 * loopback `Host` and not a name an outside caller chose.
 */
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import '@indx-workspace/react/styles.css';
import { SURFACE_DEFAULTS } from '@indx-workspace/react/theme';

import { DeploymentDriverBanner } from '../../../../../components/shell/driver-banner';

import { readTryPage } from '../../../../../server/surfaces/public/handlers';
import { TryPage } from './try-page';

export const dynamic = 'force-dynamic';

export default async function SurfaceTryPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const requestHeaders = await headers();
  const page = await readTryPage(name, requestHeaders, process.env);
  if (page === null) notFound();
  const protocol = requestHeaders.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const host = requestHeaders.get('host') ?? '';
  return (
    <TryPage
      origin={`${protocol}://${host}`}
      surfaceName={page.surfaceName}
      agentName={page.agentName}
      definition={page.surface}
      title={page.surface.title ?? page.agentName}
      locale={page.surface.theme?.locale ?? SURFACE_DEFAULTS.locale}
      promoted={page.promoted}
      modelRefusal={page.modelRefusal}
      modelSecrets={page.modelSecrets}
      platform={process.platform}
      banner={<DeploymentDriverBanner />}
    />
  );
}
