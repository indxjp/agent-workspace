/**
 * `GET /p/s/<name>` — the hosted surface chat page (ADR-0105 slice 1; S1-17, issue #455). Served
 * only where the session bootstrap it calls could be: a local runtime on loopback, asked over a
 * loopback host (`readSurfacePage` checks ADR-0105's conditions 1–3). Anything else is the same
 * `404` as a name no surface has. The surface's title, look, layout and parts (ADR-0108 rungs ①
 * and ②) are passed to the chat with its definition (S1-18, issue #456); the chat is `<Chat/>`
 * from `@indx-workspace/react`, the package a customer's page imports too (issue #623). The
 * deployment's runtime banner (A.3) renders inside the frame, as its notice row, so it never pushes
 * the composer out of the widget's iframe (issue #558). The try page renders this chat with
 * `environment: 'local'`, and a widget loaded with `?environment=local` frames it with the same
 * query; the chat then asks for the `local` working draft (issue #612).
 */
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { Chat } from '@indx-workspace/react';
import '@indx-workspace/react/styles.css';

import { DeploymentDriverBanner } from '../../../../components/shell/driver-banner';
import { readSurfacePage, surfaceModeOfQuery } from '../../../../server/surfaces/public/handlers';

export const dynamic = 'force-dynamic';

export default async function SurfacePage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { name } = await params;
  const mode = surfaceModeOfQuery((await searchParams)['environment']);
  const page = await readSurfacePage(name, await headers(), process.env, mode);
  if (page === null) notFound();
  return (
    <Chat
      {...(mode === 'try' ? { environment: 'local' as const } : {})}
      surface={page.surfaceName}
      agentName={page.agentName}
      definition={page.surface}
      notice={<DeploymentDriverBanner />}
    />
  );
}
