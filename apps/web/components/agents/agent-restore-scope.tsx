'use client';

/**
 * The link between the Restore button and the tabs of the agent page (issue #1851, slice 4;
 * #1987 B3-11). The tabs read their own state in the browser when they mount, so
 * `router.refresh()` alone, which re-renders only the server components, leaves them showing what
 * they read while the agent was frozen. A restore marks the scope, and the tabs under
 * {@link RemountOnRestore} mount again and read the restored agent.
 */
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

interface RestoreScope {
  readonly restoredCount: number;
  readonly markRestored: () => void;
}

const RestoreScopeContext = createContext<RestoreScope | null>(null);

export function AgentRestoreScope({ children }: Readonly<{ children: ReactNode }>) {
  const [restoredCount, setRestoredCount] = useState(0);
  const markRestored = useCallback(() => {
    setRestoredCount((count) => count + 1);
  }, []);
  const value = useMemo(() => ({ restoredCount, markRestored }), [restoredCount, markRestored]);
  return <RestoreScopeContext.Provider value={value}>{children}</RestoreScopeContext.Provider>;
}

/** Tell the surrounding scope the agent was restored; nothing happens outside a scope. */
export function useMarkRestored(): () => void {
  return useContext(RestoreScopeContext)?.markRestored ?? noop;
}

function noop(): void {
  // Outside an AgentRestoreScope there is nothing to remount.
}

/** Mount `children` again after each restore, so what they read in the browser is read again. */
export function RemountOnRestore({ children }: Readonly<{ children: ReactNode }>) {
  const restoredCount = useContext(RestoreScopeContext)?.restoredCount ?? 0;
  return <Fragment key={restoredCount}>{children}</Fragment>;
}
