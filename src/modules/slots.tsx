import type { ComponentType } from 'react';
import type { AppModule, SlotKind } from './types';
import { slotComponents } from './types';

/** Render every module's contribution to a slot (e.g. comments in task detail). */
export function Slot({ modules, kind, props }: { modules: AppModule[]; kind: SlotKind; props: Record<string, unknown> }) {
  return (
    <>
      {slotComponents(modules, kind).map((Comp, i) => {
        const C = Comp as ComponentType<Record<string, unknown>>;
        return <C key={i} {...props} />;
      })}
    </>
  );
}
