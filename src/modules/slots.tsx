import type { ComponentType } from 'react';
import type { AppModule, SlotKind } from './types';
import { slotComponents } from './types';

/** Render every module's contribution to a slot (e.g. comments in task detail). */
export function Slot({ modules, kind, props }: { modules: AppModule[]; kind: SlotKind; props: { taskId?: string; pageId?: string } }) {
  return (
    <>
      {slotComponents(modules, kind).map((Comp, i) => {
        const C = Comp as ComponentType<{ taskId: string; pageId: string }>;
        return <C key={i} taskId={props.taskId ?? ''} pageId={props.pageId ?? ''} />;
      })}
    </>
  );
}
