import { EditConnectionScreen } from '../../../../../components/storage/edit-connection-screen';
import { callerManagesStorage, NOT_ALLOWED } from '../manages-storage';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function EditStoragePage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await callerManagesStorage())) {
    return <p className="p-8 text-sm text-muted">{NOT_ALLOWED}</p>;
  }
  const { id } = await params;
  return <EditConnectionScreen id={id} />;
}
