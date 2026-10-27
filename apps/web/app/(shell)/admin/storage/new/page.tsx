import { NewConnectionForm } from '../../../../../components/storage/new-connection-form';
import { callerManagesStorage, NOT_ALLOWED } from '../manages-storage';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function NewStoragePage() {
  if (!(await callerManagesStorage())) {
    return <p className="p-8 text-sm text-muted">{NOT_ALLOWED}</p>;
  }
  return <NewConnectionForm />;
}
