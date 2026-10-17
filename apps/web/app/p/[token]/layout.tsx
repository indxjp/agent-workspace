import type { ReactNode } from 'react';

import { DeploymentDriverBanner } from '../../../components/shell/driver-banner';

/**
 * The share page's layout: the deployment's runtime banner above the page (A.3). The hosted
 * surface at `/p/s/<name>` draws the banner inside its own frame instead (issue #558).
 */
export default function PublicShareLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <DeploymentDriverBanner />
      {children}
    </>
  );
}
