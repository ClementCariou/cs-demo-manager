import React from 'react';
import type { ReactNode } from 'react';

type Props = {
  children: ReactNode;
};

export function AppWrapper({ children }: Props) {
  return (
    <div
      className={`flex overflow-hidden ${window.csdm.isWeb ? 'h-screen' : 'h-[calc(100vh-var(--title-bar-height))]'}`}
    >
      {children}
    </div>
  );
}
