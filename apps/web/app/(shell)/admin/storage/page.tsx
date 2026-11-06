import { StorageConnectionsScreen } from '../../../../components/storage/storage-connections-screen';
import { NotAllowedScreen } from '../../../../components/shell/screen-main';

import { callerManagesStorage, NOT_ALLOWED } from './manages-storage';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function StoragePage() {
  if (!(await callerManagesStorage())) {
    return <NotAllowedScreen title="Storage">{NOT_ALLOWED}</NotAllowedScreen>;
  }
  return <StorageConnectionsScreen />;
}
