import { FilesScreen } from '../../../components/resources/resource-screens';
import { switchedOffPanel } from '../feature-gate';

export const dynamic = 'force-dynamic';
export default async function FilesPage() {
  const off = await switchedOffPanel('files');
  if (off !== null) return off;
  return <FilesScreen />;
}
