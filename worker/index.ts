import { Hono } from 'hono';
import { auth, me } from './auth';
import { sync } from './sync';
import { admin } from './admin';
import type { Env, AuthUser } from './auth';

const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

app.onError((err, c) => {
  console.error(JSON.stringify({ message: err.message, stack: err.stack }));
  return c.json({ error: 'internal error' }, 500);
});

app.route('/api/auth', auth);
app.route('/api/me', me);
app.route('/api/sync', sync);
app.route('/api', admin);

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

export default app;
