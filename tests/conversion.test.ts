import { describe, expect, it } from 'vitest';
import { planConversion } from '../shared/conversion';
import { linkId } from '../shared/linkid';

let seq = 0;
const id = () => `new${++seq}`;
const now = 1_800_000_000_000;

const srcBoard = {
  id: 'db_ideas',
  name: 'Ideas',
  columns: [
    { id: 'c_captured', name: 'Captured' },
    { id: 'c_converted', name: 'Converted' },
  ],
  fields: [
    { id: 'f_theme', name: 'Theme', type: 'multi_select', options: [{ id: 'o1', name: 'Water', color: '#00f' }] },
    { id: 'f_impact', name: 'Impact', type: 'select' },
    { id: 'f_budget', name: 'Budget', type: 'text' }, // same id, different type on dest
    { id: 'f_ghost', name: 'Ghost', type: 'text' },
  ],
};

const destBoard = {
  id: 'db_projects',
  name: 'Projects',
  columns: [{ id: 'c_idea', name: 'Idea' }, { id: 'c_active', name: 'Active' }],
  fields: [
    { id: 'f_theme', name: 'Theme', type: 'multi_select', options: [{ id: 'o1', name: 'Water', color: '#00f' }] },
    { id: 'f_impact', name: 'Impact', type: 'text' }, // type mismatch → dropped
    { id: 'f_budget', name: 'Budget', type: 'text' }, // same id + type → copied
    // f_ghost absent → dropped
  ],
};

const src = {
  id: 'r_idea1',
  boardId: 'db_ideas',
  title: 'Rain harvester',
  description: 'Collect monsoon water',
  status: 'c_captured',
  p_f_theme: ['o1'],
  p_f_impact: 's_high',
  p_f_budget: 'some text',
  p_f_ghost: 'x',
  p_f_stray: 'no field anywhere',
  assigneeId: 'u1',
};

describe('planConversion', () => {
  it('happy path: dest record + dest→src link + source stage patch', () => {
    const res = planConversion({ src, srcBoard, destBoard, sourceStage: 'c_converted', actorId: 'u-me' }, { id, now });
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    const [dest, link, stage] = res.ops;

    expect(dest.collection).toBe('tasks');
    expect(dest.id).toBe(res.destId);
    expect(dest.patch).toMatchObject({
      boardId: 'db_projects',
      title: 'Rain harvester',
      description: 'Collect monsoon water',
      status: 'c_idea', // dest first column
      convertedFrom: 'r_idea1',
      p_f_theme: ['o1'], // same id + same type → copied
      p_f_budget: 'some text',
      createdBy: 'u-me',
      createdAt: now,
    });
    // mismatched/missing/stray props and builtins not copied
    expect(dest.patch.p_f_impact).toBeUndefined();
    expect(dest.patch.p_f_ghost).toBeUndefined();
    expect(dest.patch.p_f_stray).toBeUndefined();
    expect(dest.patch.assigneeId).toBeUndefined();

    expect(link.collection).toBe('links');
    expect(link.id).toBe(linkId('related', null, res.destId, 'r_idea1'));
    expect(link.patch).toMatchObject({ fromId: res.destId, toId: 'r_idea1', kind: 'related', fieldId: null });

    expect(stage.collection).toBe('tasks');
    expect(stage.id).toBe('r_idea1');
    expect(stage.patch).toEqual({ status: 'c_converted' });

    expect(res.warnings).toHaveLength(3);
    expect(res.warnings.join(' ')).toContain('f_impact');
    expect(res.warnings.join(' ')).toContain('f_ghost');
    expect(res.warnings.join(' ')).toContain('f_stray');
  });

  it('defaults: no sourceStage → no stage op; title/linkKind overrides honored', () => {
    const res = planConversion({ src, srcBoard, destBoard, title: 'New name', linkKind: 'blocks' }, { id, now });
    if ('error' in res) throw new Error(res.error);
    expect(res.ops).toHaveLength(2);
    expect(res.ops[0].patch.title).toBe('New name');
    expect(res.ops[1].patch.kind).toBe('blocks');
  });

  it('invalid sourceStage errors; invalid db errors', () => {
    expect(planConversion({ src, srcBoard, destBoard, sourceStage: 'nope' }, { id, now })).toEqual({ error: "unknown stage 'nope' for source board" });
    expect(planConversion({ src, srcBoard, destBoard: undefined as never }, { id, now })).toEqual({ error: 'destination database not found' });
    expect(planConversion({ src: undefined as never, srcBoard, destBoard }, { id, now })).toEqual({ error: 'source record not found' });
  });

  it('worker Rec shape ({id, data}) unwraps the same way', () => {
    const res = planConversion(
      {
        src: { id: 'r_idea1', data: src },
        srcBoard: { id: 'db_ideas', data: srcBoard },
        destBoard: { id: 'db_projects', data: destBoard },
      },
      { id, now },
    );
    if ('error' in res) throw new Error(res.error);
    expect(res.ops[0].patch.convertedFrom).toBe('r_idea1');
    expect(res.ops[0].patch.boardId).toBe('db_projects');
  });

  it('templateId stamps provenance on the dest record', () => {
    const res = planConversion({ src, srcBoard, destBoard, templateId: 'tpl-project' }, { id, now });
    if ('error' in res) throw new Error(res.error);
    expect(res.ops[0].patch.templateId).toBe('tpl-project');
  });
});
