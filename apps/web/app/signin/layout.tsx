import type { ReactNode } from 'react';

import { DeploymentDriverBanner } from '../../components/shell/driver-banner';

export default function SignInLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <DeploymentDriverBanner dismissible={false} />
      {children}
    </>
  );
}
