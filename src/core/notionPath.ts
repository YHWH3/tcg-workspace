/* The Common Ground website sends people here from `thecommonground.living/notion`.
 * The app is served from its own root, so a redirect that keeps the prefix
 * (`/notion/boards/x`) lands on the same route without it. Pure, unit-tested. */

export function stripNotionPrefix(pathname: string): string {
  const rest = pathname.replace(/^\/notion(?=\/|$)/i, '');
  if (rest === pathname) return pathname;
  // Collapse leading slashes so `/notion//evil.example` stays same-origin.
  const clean = '/' + rest.replace(/^\/+/, '');
  return clean;
}
