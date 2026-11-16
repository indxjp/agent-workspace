import { Dashboard } from '@indx-workspace/app/react';
import { appRuntime } from '@indx-workspace/app/server';

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  return (
    <main>
      <h1>Dashboard</h1>
      <Dashboard platformUrl={appRuntime().awUrl} />
    </main>
  );
}
