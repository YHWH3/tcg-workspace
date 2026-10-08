import { describe, expect, it } from 'vitest';
import { parseLinkUrl } from '../shared/drive';

describe('parseLinkUrl — Google Drive patterns', () => {
  it('drive.google.com/file/d/<id>/view → file preview', () => {
    const r = parseLinkUrl('https://drive.google.com/file/d/1AbC-_xYz9/view?usp=sharing');
    expect(r).toEqual({
      provider: 'gdrive',
      url: 'https://drive.google.com/file/d/1AbC-_xYz9/view?usp=sharing',
      embedUrl: 'https://drive.google.com/file/d/1AbC-_xYz9/preview',
      fileId: '1AbC-_xYz9',
    });
  });

  it('drive.google.com/open?id=<id> → file preview', () => {
    const r = parseLinkUrl('https://drive.google.com/open?id=1RealFileId_9');
    expect(r).toMatchObject({ provider: 'gdrive', fileId: '1RealFileId_9', embedUrl: 'https://drive.google.com/file/d/1RealFileId_9/preview' });
  });

  it('drive.google.com/drive/folders/<id> → embedded folder grid', () => {
    const r = parseLinkUrl('https://drive.google.com/drive/folders/0Folder_Id-123');
    expect(r).toMatchObject({
      provider: 'gdrive',
      fileId: '0Folder_Id-123',
      embedUrl: 'https://drive.google.com/embeddedfolderview?id=0Folder_Id-123#grid',
    });
  });

  it('drive.google.com/drive/u/1/folders/<id> → embedded folder grid', () => {
    const r = parseLinkUrl('https://drive.google.com/drive/u/1/folders/FoldX');
    expect(r).toMatchObject({ provider: 'gdrive', fileId: 'FoldX' });
  });

  it('docs.google.com/document/d/<id>/edit → doc preview', () => {
    const r = parseLinkUrl('https://docs.google.com/document/d/DocId-123/edit');
    expect(r).toMatchObject({ provider: 'gdrive', fileId: 'DocId-123', embedUrl: 'https://docs.google.com/document/d/DocId-123/preview' });
  });

  it('docs.google.com/spreadsheets/d/<id> → sheet preview', () => {
    const r = parseLinkUrl('https://docs.google.com/spreadsheets/d/Sheet_9/edit#gid=0');
    expect(r).toMatchObject({ provider: 'gdrive', embedUrl: 'https://docs.google.com/spreadsheets/d/Sheet_9/preview' });
  });

  it('docs.google.com/presentation/d/<id> → deck preview', () => {
    const r = parseLinkUrl('https://docs.google.com/presentation/d/Deck-1/present');
    expect(r).toMatchObject({ provider: 'gdrive', embedUrl: 'https://docs.google.com/presentation/d/Deck-1/preview' });
  });
});

describe('parseLinkUrl — non-drive + invalid', () => {
  it('ordinary URLs classify as link with hostname+path title', () => {
    const r = parseLinkUrl('https://example.com/a/b?x=1');
    expect(r).toEqual({ provider: 'link', url: 'https://example.com/a/b?x=1', title: 'example.com/a/b' });
  });

  it('drive.google.com URLs without a file id still classify as link', () => {
    expect(parseLinkUrl('https://drive.google.com/drive/my-drive')).toMatchObject({ provider: 'link' });
  });

  it('rejects non-URLs, whitespace and non-http(s) schemes', () => {
    expect(parseLinkUrl('not a url')).toBeNull();
    expect(parseLinkUrl('hello world https://x.test')).toBeNull();
    expect(parseLinkUrl('ftp://x.test/f')).toBeNull();
    expect(parseLinkUrl('')).toBeNull();
    expect(parseLinkUrl('  ')).toBeNull();
  });
});
