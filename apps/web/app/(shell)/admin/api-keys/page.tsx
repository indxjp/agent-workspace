import { ApiKeysScreen } from '../../../../components/resources/resource-screens';
import { ScreenMain } from '../../../../components/shell/screen-main';

export const dynamic = 'force-dynamic';
export default function ApiKeysPage() {
  return (
    <ScreenMain>
      <ApiKeysScreen />
    </ScreenMain>
  );
}
