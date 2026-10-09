import { describe, expect, it } from 'vitest';
import {
  allowedCanvasFiles,
  allowedFileIds,
  canServeBoardShare,
  canServeFile,
  canServePage,
  descendantIds,
  expandThumbs,
  publicCanvasItem,
} from '../worker/publicAccess';

const pages = [
  { id: 'root' },
  { id: 'child', parentId: 'root' },
  { id: 'grand', parentId: 'child' },
  { id: 'dead', parentId: 'root', deleted: true },
  { id: 'deadchild', parentId: 'dead' },
  { id: 'other' },
  { id: 'otherChild', parentId: 'other' },
];

describe('descendantIds', () => {
  it('includes the root and all live descendants', () => {
    const tree = descendantIds(pages, 'root');
    expect(tree).toEqual(new Set(['root', 'child', 'grand']));
  });
  it('excludes deleted branches entirely', () => {
    expect(descendantIds(pages, 'root').has('deadchild')).toBe(false);
  });
  it('non-descendant pages are denied', () => {
    const tree = descendantIds(pages, 'root');
    expect(canServePage('other', tree)).toBe(false);
    expect(canServePage('otherChild', tree)).toBe(false);
    expect(canServePage('grand', tree)).toBe(true);
  });
});

describe('file access', () => {
  const blocks = [
    { id: 'b1', pageId: 'child', fileId: 'img1' },
    { id: 'b2', pageId: 'grand', fileId: 'pdf1', deleted: false },
    { id: 'b3', pageId: 'other', fileId: 'secret' }, // outside the tree
    { id: 'b4', pageId: 'child', fileId: 'gone', deleted: true }, // deleted block
  ];
  const files = [
    { id: 'img1', thumbId: 'img1t' },
    { id: 'pdf1' },
    { id: 'cover1' },
    { id: 'img1t' },
    { id: 'secret' },
  ];
  const tree = descendantIds(pages, 'root');
  const allowed = expandThumbs(allowedFileIds(blocks, tree, ['cover1']), files);

  it('serves files referenced by blocks inside the tree', () => {
    expect(canServeFile('img1', allowed, files)).toBe(true);
    expect(canServeFile('pdf1', allowed, files)).toBe(true);
  });
  it('serves task covers shown by tasks blocks', () => {
    expect(canServeFile('cover1', allowed, files)).toBe(true);
  });
  it('serves the thumbnail of an allowed file', () => {
    expect(canServeFile('img1t', allowed, files)).toBe(true);
  });
  it('denies unreferenced files and files only referenced outside the tree', () => {
    expect(canServeFile('secret', allowed, files)).toBe(false);
    expect(canServeFile('gone', allowed, files)).toBe(false);
    expect(canServeFile('random', allowed, files)).toBe(false);
  });
});

describe('canvas shares', () => {
  const items = [
    { id: 'i1', boardId: 'mb1', type: 'image', fileId: 'pic1' },
    { id: 'i2', boardId: 'mb1', type: 'note', text: 'hi' },
    { id: 'i3', boardId: 'mb1', type: 'image', fileId: 'old', deleted: true },
    { id: 'i4', boardId: 'mb2', type: 'image', fileId: 'otherboard' }, // another board's item
    { id: 'i5', boardId: 'mb1', type: 'svg', svg: '<svg/>' }, // inline svg, no file
  ];
  const files = [
    { id: 'pic1', thumbId: 'pic1t' },
    { id: 'pic1t' },
    { id: 'otherboard' },
    { id: 'old' },
  ];
  const allowed = allowedCanvasFiles(items, 'mb1', files);

  it('share serves only its own board', () => {
    expect(canServeBoardShare({ target_type: 'moodboard', page_id: 'mb1' }, 'mb1')).toBe(true);
    expect(canServeBoardShare({ target_type: 'moodboard', page_id: 'mb1' }, 'mb2')).toBe(false);
    expect(canServeBoardShare({ target_type: 'page', page_id: 'mb1' }, 'mb1')).toBe(false);
  });

  it('serves files on the board (and thumbs), rejects everything else', () => {
    expect(canServeFile('pic1', allowed, files)).toBe(true);
    expect(canServeFile('pic1t', allowed, files)).toBe(true);
    expect(canServeFile('otherboard', allowed, files)).toBe(false); // on another board
    expect(canServeFile('old', allowed, files)).toBe(false); // deleted item
    expect(canServeFile('unrelated', allowed, files)).toBe(false);
  });

  it('card payload reduces to {ref, title, stage} — no record body/fields/links', () => {
    const out = publicCanvasItem(
      {
        id: 'c1',
        type: 'card',
        x: 10,
        y: 20,
        w: 200,
        h: 120,
        z: 'a',
        ref: { type: 'record', id: 'task-secret' },
        title: 'should be dropped',
        taskId: 'legacy-id',
        frameStageOf: { databaseId: 'db1', stageId: 's1' },
      },
      { title: 'Record title', stage: 'Doing' },
    );
    expect(out.type).toBe('card');
    expect(out.ref).toEqual({ type: 'record', id: 'task-secret' });
    expect(out.card).toEqual({ title: 'Record title', stage: 'Doing' });
    for (const k of Object.keys(out)) {
      expect(['id', 'type', 'x', 'y', 'w', 'h', 'z', 'parentFrameId', 'ref', 'card']).toContain(k);
    }
  });

  it('card payload for a missing/deleted ref stays minimal', () => {
    const out = publicCanvasItem({ id: 'c2', type: 'card', ref: { type: 'record', id: 'gone' } }, null);
    expect(out.card).toEqual({ title: null, stage: null });
  });

  it('legacy taskId cards degrade to a record ref', () => {
    const out = publicCanvasItem({ id: 'c3', type: 'card', taskId: 't9' }, { title: 'T', stage: 'Done' });
    expect(out.ref).toEqual({ type: 'record', id: 't9' });
  });

  it('non-card items keep only their render fields', () => {
    const out = publicCanvasItem({ id: 'n1', type: 'note', text: 'hello', x: 1, y: 2, w: 10, h: 10, z: 'a', secret: 'x' });
    expect(out).toEqual({ id: 'n1', type: 'note', text: 'hello', x: 1, y: 2, w: 10, h: 10, z: 'a' });
    expect('secret' in out).toBe(false);
    const conn = publicCanvasItem({ id: 'k1', type: 'connector', from: 'i1', to: 'i2', label: 'l', style: 'elbow', arrow: 'both', linkKind: 'blocks', secret: 'x' });
    expect(conn).toEqual({ id: 'k1', type: 'connector', from: 'i1', to: 'i2', label: 'l', style: 'elbow', arrow: 'both', linkKind: 'blocks' });
  });
});
