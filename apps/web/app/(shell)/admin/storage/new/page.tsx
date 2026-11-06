import { NewConnectionForm } from '../../../../../components/storage/new-connection-form';
import { NotAllowedScreen } from '../../../../../components/shell/screen-main';
import { callerManagesStorage, NOT_ALLOWED } from '../manages-storage';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function NewStoragePage() {
  if (!(await callerManagesStorage())) {
    return <NotAllowedScreen title="Connect storage">{NOT_ALLOWED}</NotAllowedScreen>;
  }
  return <NewConnectionForm />;
}
