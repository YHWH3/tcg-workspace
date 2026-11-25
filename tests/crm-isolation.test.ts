import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../shared/collections';

const ROOT = resolve(import.meta.dirname, '..');

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTsFiles(full));
    else if (/\.(ts|tsx|css)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('CRM isolation & bundle boundaries', () => {
  it('imports src/apps/crm lazily only from src/routes.tsx and never from Workspace or AppSwitcher', () => {
    const srcFiles = walkTsFiles(join(ROOT, 'src')).filter(
      (f) => !f.startsWith(join(ROOT, 'src/apps/crm/')),
    );
    const offenders: string[] = [];
    for (const file of srcFiles) {
      const content = readFileSync(file, 'utf8');
      if (/apps\/crm/.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([join(ROOT, 'src/routes.tsx')]);

    const routesSource = readFileSync(join(ROOT, 'src/routes.tsx'), 'utf8');
    expect(routesSource).toMatch(/lazy\(\(\)\s*=>\s*import\(['"]\.\/apps\/crm\/CrmShell['"]\)\)/);
    expect(routesSource).not.toMatch(/from\s+['"]\.\/apps\/crm/);

    const switcherSource = readFileSync(join(ROOT, 'src/core/AppSwitcher.tsx'), 'utf8');
    expect(switcherSource).not.toMatch(/apps\/crm/);
    const statusSource = readFileSync(join(ROOT, 'src/core/crmStatus.ts'), 'utf8');
    expect(statusSource).not.toMatch(/apps\/crm/);
  });

  it('imports crm.css only in CrmShell and scopes every CSS selector under [data-app="crm"]', () => {
    const srcFiles = walkTsFiles(join(ROOT, 'src'));
    const cssImporters = srcFiles.filter((f) => /crm\.css/.test(readFileSync(f, 'utf8')));
    expect(cssImporters).toEqual([join(ROOT, 'src/apps/crm/CrmShell.tsx')]);

    const css = readFileSync(join(ROOT, 'src/apps/crm/crm.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@keyframes[\s\S]*?\n\}/g, '');

    // Extract selector headers before '{' (including nested inside @media blocks).
    const strippedMedia = css.replace(/@media\s*\([^)]*\)\s*\{/g, '');
    const selectorMatches = [...strippedMedia.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());
    expect(selectorMatches.length).toBeGreaterThan(0);

    for (const group of selectorMatches) {
      for (const selector of group.split(',').map((s) => s.trim()).filter(Boolean)) {
        expect(
          selector.startsWith('[data-app="crm"]') || selector.startsWith('.dark [data-app="crm"]'),
          `Unscoped CSS selector in crm.css: ${selector}`,
        ).toBe(true);
      }
    }
  });

  it('leaves Workspace COLLECTIONS unchanged and avoids _crm_ writes or /crm presence leaks', () => {
    expect(COLLECTIONS).not.toContain('crm_commands');
    expect(COLLECTIONS).not.toContain('crm_capability_grants');
    expect(COLLECTIONS).not.toContain('crm_capability_audit');

    const crmFiles = walkTsFiles(join(ROOT, 'src/apps/crm'));
    for (const file of crmFiles) {
      const content = readFileSync(file, 'utf8');
      expect(content).not.toMatch(/['"]_crm_/);
      expect(content).not.toMatch(/mutate\([^)]*crmProjectionKey/);
      expect(content).not.toMatch(/sendHere\(\s*['"]\/crm/);
    }
  });
});
