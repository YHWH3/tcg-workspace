import { describe, expect, it } from 'vitest';
import { sanitizeSvg, SVG_MAX_NODES } from '../shared/svgSanitize';

const ok = (input: string) => {
  const r = sanitizeSvg(input);
  if (!r.ok) throw new Error(`expected ok, got ${r.reasons.join(', ')}`);
  return r.svg;
};
const bad = (input: unknown): string[] => {
  const r = sanitizeSvg(input);
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.reasons;
};

describe('benign input round-trips', () => {
  it('simple icon preserves geometry + adds xmlns', () => {
    const out = ok('<svg viewBox="0 0 24 24"><path d="M5 12l4 4 10-10" stroke="black"/></svg>');
    expect(out).toContain('viewBox="0 0 24 24"');
    expect(out).toContain('d="M5 12l4 4 10-10"');
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('defs/gradient/use internal refs survive', () => {
    const out = ok(
      '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
        '<rect width="10" height="10" fill="url(#g)"/><use href="#g"/></svg>',
    );
    expect(out).toContain('linearGradient');
    expect(out).toContain('fill="url(#g)"');
    expect(out).toContain('href="#g"');
  });

  it('xlink:href fragment kept, xmlns:xlink emitted', () => {
    const out = ok('<svg><use xlink:href="#icon-ok"/></svg>');
    expect(out).toContain('xlink:href="#icon-ok"');
    expect(out).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  });

  it('style with fragment url() and plain declarations kept', () => {
    const out = ok('<svg><rect style="fill:url(#a);stroke:red;opacity:0.5"/></svg>');
    expect(out).toContain('style="fill:url(#a);stroke:red;opacity:0.5"');
  });

  it('entities decode and re-escape canonically', () => {
    const out = ok('<svg><text>a &amp; b &lt;ok&gt; &#65;</text></svg>');
    expect(out).toContain('a &amp; b &lt;ok&gt; A');
  });

  it('CDATA text content survives as text', () => {
    const out = ok('<svg><text><![CDATA[1 < 2]]></text></svg>');
    expect(out).toContain('1 &lt; 2');
  });

  it('tolerates unclosed tags and stray closes', () => {
    const out = ok('<svg><g><rect width="10" height="10"></svg>');
    expect(out).toContain('<rect');
    expect(out).toContain('width="10"');
  });

  it('tolerates comments, PIs and whitespace around the root', () => {
    const out = ok('<?xml version="1.0"?>\n<!-- made by hand -->\n<svg><circle r="5"/></svg>\n');
    expect(out).toContain('<circle r="5"/>');
    expect(out).not.toContain('xml version');
  });

  it('literal < in text is escaped', () => {
    const out = ok('<svg><text>a < b</text></svg>');
    expect(out).toContain('a &lt; b');
  });
});

describe('adversarial corpus', () => {
  it('drops <script> with its body', () => {
    const out = ok('<svg><script>alert(1)</script><rect width="4" height="4"/></svg>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');
    expect(out).toContain('<rect');
  });

  it('drops mixed-case script evasions', () => {
    const out = ok('<svg><ScRiPt>alert(2)</ScRiPt></svg>');
    expect(out).not.toContain('alert');
  });

  it('drops on* event attributes', () => {
    const out = ok('<svg onload="alert(1)"><rect width="2" height="2" onclick="x()" OnMouseOver="y"/></svg>');
    expect(out).not.toContain('onload');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('OnMouseOver');
  });

  it('drops javascript:/data:/external hrefs but keeps the element', () => {
    const out = ok(
      '<svg><use href="javascript:alert(1)"/><use xlink:href="data:image/svg+xml,evil"/>' +
        '<use href="https://evil.example/x.svg#i"/><use href="#legit"/></svg>',
    );
    expect(out).toContain('href="#legit"');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('data:image');
    expect(out).not.toContain('evil.example');
  });

  it('drops entity-encoded javascript: href', () => {
    const out = ok('<svg><use href="&#106;avascript:alert(1)"/></svg>');
    expect(out).not.toContain('avascript');
  });

  it('drops <image> entirely, even with internal hrefs', () => {
    const out = ok('<svg><image href="https://evil/x.png"/><image href="#ok"/></svg>');
    expect(out).not.toContain('image');
  });

  it('drops foreignObject and iframe subtrees', () => {
    const out = ok(
      '<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><iframe src="//evil"></iframe><script>x()</script></body></foreignObject><rect width="1" height="1"/></svg>',
    );
    expect(out).not.toContain('foreignObject');
    expect(out).not.toContain('iframe');
    expect(out).not.toContain('body');
    expect(out).toContain('<rect');
  });

  it('drops DOCTYPE and never expands entities (no billion laughs)', () => {
    const out = ok(
      '<!DOCTYPE svg [<!ENTITY a "AAAAAAAAAA"><!ENTITY b "&a;&a;&a;&a;&a;">]>' +
        '<svg><text>&b;</text></svg>',
    );
    expect(out).not.toContain('DOCTYPE');
    expect(out).not.toContain('AAAA');
    expect(out).not.toContain('&b;');
  });

  it('drops url() exfil in style attributes', () => {
    const cases = [
      'fill:url(http://evil/x)',
      "background:url('https://evil/x')",
      'fill:URL(#ok)\n;background:url(javascript:alert(1))',
      'list-style:url( data:image/svg+xml;base64,AAA )',
    ];
    for (const s of cases) {
      const out = ok(`<svg><rect style="${s.replace(/"/g, '&quot;')}" width="1" height="1"/></svg>`);
      expect(out, s).not.toContain('style=');
    }
  });

  it('keeps fragment-only url() in style', () => {
    const out = ok('<svg><rect style="fill:url(#g)" width="1" height="1"/></svg>');
    expect(out).toContain('style="fill:url(#g)"');
  });

  it('drops non-fragment url() in any attribute', () => {
    const out = ok('<svg><rect fill="url(http://evil)" clip-path="url(#ok)" width="1" height="1"/></svg>');
    expect(out).not.toContain('url(http://evil)');
    expect(out).toContain('clip-path="url(#ok)"');
  });

  it('drops dangerous style keywords', () => {
    for (const s of ['width:expression(alert(1))', 'behavior:url(#x)', '-moz-binding:url(#x)']) {
      const out = ok(`<svg><rect style="${s}"/></svg>`);
      expect(out).not.toContain('style=');
    }
  });

  it('drops nested elements inside a disallowed wrapper', () => {
    const out = ok('<svg><a href="https://evil"><rect width="2" height="2"/></a><circle r="1"/></svg>');
    expect(out).not.toContain('<rect');
    expect(out).not.toContain('evil');
    expect(out).toContain('<circle');
  });

  it('drops namespaced junk elements/attributes', () => {
    const out = ok('<svg xmlns:sodi="urn:x"><sodi:namedview/><rect width="1" height="1" sodi:foo="bar"/></svg>');
    expect(out).not.toContain('namedview');
    expect(out).not.toContain('sodi:foo');
  });

  it('rejects input over 1MB', () => {
    const huge = '<svg>' + 'x'.repeat(1024 * 1024) + '</svg>';
    expect(bad(huge)).toContain('input-exceeds-1048576-bytes');
  });

  it('rejects over 20k nodes', () => {
    const many = `<svg>${'<rect/>'.repeat(SVG_MAX_NODES)}</svg>`;
    const reasons = bad(many);
    expect(reasons.some((r) => r.includes('nodes'))).toBe(true);
  });

  it('rejects non-svg roots and non-string input', () => {
    expect(bad('<html><body/></html>')).toContain('no-svg-root');
    expect(bad('<div/>')).toContain('no-svg-root');
    expect(bad('plain text')).toContain('no-svg-root');
    expect(bad(null)).toContain('input-not-string');
    expect(bad(123)).toContain('input-not-string');
    expect(bad('   ')).toContain('empty-input');
  });

  it('rejects a truncated root tag at EOF', () => {
    expect(bad('<?xml version="1.0"?><svg')).toContain('no-svg-root');
  });

  it('entity attack vector inside attribute cannot resurrect a handler', () => {
    const out = ok('<svg><rect width="1" height="1" style="fill:url(&#x68;ttp://evil)"/></svg>');
    expect(out).not.toContain('ttp://evil');
    expect(out).not.toContain('style=');
  });
});

describe('canonical output', () => {
  it('serializes with sorted attributes and self-closing empty elements', () => {
    const out = ok('<svg height="100" viewBox="0 0 10 10" width="100"><rect y="1" x="0" width="1" height="1"></rect></svg>');
    expect(out).toBe(
      '<svg height="100" viewBox="0 0 10 10" width="100" xmlns="http://www.w3.org/2000/svg"><rect height="1" width="1" x="0" y="1"/></svg>',
    );
  });
});
