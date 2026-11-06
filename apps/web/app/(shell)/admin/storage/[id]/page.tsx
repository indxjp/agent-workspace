import { EditConnectionScreen } from '../../../../../components/storage/edit-connection-screen';
import { NotAllowedScreen } from '../../../../../components/shell/screen-main';
import { callerManagesStorage, NOT_ALLOWED } from '../manages-storage';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function EditStoragePage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await callerManagesStorage())) {
    return <NotAllowedScreen title="Edit storage connection">{NOT_ALLOWED}</NotAllowedScreen>;
  }
  const { id } = await params;
  return <EditConnectionScreen id={id} />;
}
