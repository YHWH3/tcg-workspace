export const COLLECTIONS = ['pages', 'blocks', 'tasks', 'comments', 'activity'] as const;

export type Collection = (typeof COLLECTIONS)[number];

export function isCollection(value: string): value is Collection {
  return (COLLECTIONS as readonly string[]).includes(value);
}
