'use client';

import { useEffect, useRef } from 'react';

/** A message that takes focus when it appears, so a keyboard user lands on what went wrong. */
export function Problem({ message }: Readonly<{ message: string }>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="mt-4 rounded-(--radius) border border-danger bg-danger-soft p-4 text-[13px] text-danger"
    >
      {message}
    </div>
  );
}
