import { DashboardPage } from '../../components/dashboard-page';
import { localeOf } from '../../components/words';
import { DESK_PLATFORM_URL } from '../../server/desk';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

export default async function DeskDashboardPage(props: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { lang } = await props.searchParams;
  return <DashboardPage locale={localeOf(lang)} platformUrl={DESK_PLATFORM_URL} />;
}
