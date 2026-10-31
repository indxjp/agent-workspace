import { ConnectorNewScreen } from '../../../../components/resources/resource-screens';
import { switchedOffPanel } from '../../feature-gate';

export const dynamic = 'force-dynamic';
export default async function ConnectorNewPage() {
  const off = await switchedOffPanel('connectors');
  if (off !== null) return off;
  return <ConnectorNewScreen />;
}
