import { ConnectorsScreen } from '../../../components/resources/resource-screens';
import { switchedOffPanel } from '../feature-gate';

export const dynamic = 'force-dynamic';
export default async function ConnectorsPage() {
  const off = await switchedOffPanel('connectors');
  if (off !== null) return off;
  return <ConnectorsScreen />;
}
