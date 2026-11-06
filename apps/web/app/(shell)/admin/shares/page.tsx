import { SharedLinksScreen } from '../../../../components/shares/shared-links-screen';
import { switchedOffPanel } from '../../feature-gate';
export default async function SharedLinksPage() {
  const off = await switchedOffPanel('sharing');
  if (off !== null) return off;
  return <SharedLinksScreen />;
}
