import { describe, expect, it } from 'vitest';
import { allowedFileIds, canServeFile, canServePage, descendantIds, expandThumbs } from '../worker/publicAccess';

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
