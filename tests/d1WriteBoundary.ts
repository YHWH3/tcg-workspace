/** Inject faults/races at actual record commits. Read-only batches must not
 * advance the injection point. All statements still execute on real SQLite. */
export function interceptRecordWrites(
  db: D1Database,
  intercept: (target: D1Database, statements: D1PreparedStatement[], index: number) => Promise<D1Result[]>,
): D1Database {
  let writes = 0;
  return interceptD1Batches(db, (target, statements, sql) => sql.some(s => /INSERT\s+INTO\s+records\b/i.test(s))
    ? intercept(target, statements, ++writes) : target.batch(statements));
}

export function interceptD1Batches(
  db: D1Database,
  intercept: (target: D1Database, statements: D1PreparedStatement[], sql: string[]) => Promise<D1Result[]>,
): D1Database {
  const originals = new WeakMap<object, D1PreparedStatement>(), sqlByStatement = new WeakMap<object, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, { get(target, key) {
      if (key === 'bind') return (...values: Parameters<D1PreparedStatement['bind']>) => wrap(target.bind(...values), sql);
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    originals.set(proxy, statement); sqlByStatement.set(proxy, sql); return proxy;
  };
  return new Proxy(db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      const unwrapped = statements.map(s => originals.get(s) ?? s);
      return intercept(target, unwrapped, statements.map(s => sqlByStatement.get(s) ?? ''));
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
