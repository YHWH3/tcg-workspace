import { describe, expect, it } from 'vitest';
import { stripNotionPrefix } from '../src/core/notionPath';

describe('stripNotionPrefix (thecommonground.living/notion redirect)', () => {
  it('maps the prefix onto the app root', () => {
    expect(stripNotionPrefix('/notion')).toBe('/');
    expect(stripNotionPrefix('/notion/')).toBe('/');
    expect(stripNotionPrefix('/notion/boards/board-website-inbox')).toBe('/boards/board-website-inbox');
    expect(stripNotionPrefix('/Notion/tasks/web_1')).toBe('/tasks/web_1');
  });
  it('leaves other paths alone and never yields a protocol-relative URL', () => {
    expect(stripNotionPrefix('/notions')).toBe('/notions');
    expect(stripNotionPrefix('/boards/x')).toBe('/boards/x');
    expect(stripNotionPrefix('/notion//evil.example/x')).toBe('/evil.example/x');
  });
});
