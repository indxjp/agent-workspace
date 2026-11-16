'use client';
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface TabSpec {
  readonly id: string;
  readonly label: string;
  readonly panel: ReactNode;
}

/**
 * The detail page's tabs, addressed by the address's fragment (`#try`, `#customize`, `#code`). Every
 * panel is drawn by the server and the others are hidden, so nothing reloads when a tab is chosen.
 */
export function Tabs({
  tabs,
  label,
}: {
  readonly tabs: readonly TabSpec[];
  readonly label: string;
}) {
  const [active, setActive] = useState(tabs[0]?.id ?? '');
  useEffect(() => {
    const fromHash = () => {
      const id = window.location.hash.slice(1);
      if (tabs.some((tab) => tab.id === id)) setActive(id);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => {
      window.removeEventListener('hashchange', fromHash);
    };
  }, [tabs]);
  const choose = (id: string) => {
    setActive(id);
    window.history.replaceState(null, '', `#${id}`);
  };
  const onKey = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (step === 0 || next === undefined) return;
    event.preventDefault();
    choose(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };
  return (
    <div className="store-tabs">
      <div role="tablist" aria-label={label}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={tab.id === active}
            aria-controls={`panel-${tab.id}`}
            tabIndex={tab.id === active ? 0 : -1}
            onClick={() => {
              choose(tab.id);
            }}
            onKeyDown={(event) => {
              onKey(event, index);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={`panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`tab-${tab.id}`}
          hidden={tab.id !== active}
        >
          {tab.panel}
        </div>
      ))}
    </div>
  );
}
