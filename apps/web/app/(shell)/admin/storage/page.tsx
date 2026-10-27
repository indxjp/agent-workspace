import { StorageConnectionsScreen } from '../../../../components/storage/storage-connections-screen';

import { callerManagesStorage, NOT_ALLOWED } from './manages-storage';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function StoragePage() {
  if (!(await callerManagesStorage())) {
    return <p className="p-8 text-sm text-muted">{NOT_ALLOWED}</p>;
  }
  return <StorageConnectionsScreen />;
}
