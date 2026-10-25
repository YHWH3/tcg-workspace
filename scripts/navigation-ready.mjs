// This runner intentionally hard-navigates between acceptance surfaces. Wait for
// foreground reads to finish so teardown does not create WebKit fetch diagnostics.
// No browser error is removed or reclassified; stalled reads still fail the test.
const pageReads = new WeakMap();

function readsFor(page) {
  let state = pageReads.get(page);
  if (state) return state;
  state = { pending: new Set(), changed: new Set() };
  const notify = () => { for (const listener of state.changed) listener(); };
  page.on('request', request => {
    if (!new URL(request.url()).pathname.startsWith('/api/')) return;
    state.pending.add(request); notify();
  });
  for (const event of ['requestfinished', 'requestfailed']) page.on(event, request => {
    if (state.pending.delete(request)) notify();
  });
  pageReads.set(page, state);
  return state;
}

export async function waitForApiReads(page) {
  const state = readsFor(page);
  await new Promise((resolve, reject) => {
    let quiet;
    const finish = error => {
      clearTimeout(quiet); clearTimeout(deadline); state.changed.delete(check);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      clearTimeout(quiet);
      if (!state.pending.size) quiet = setTimeout(() => finish(), 250);
    };
    const deadline = setTimeout(() => finish(new Error('Foreground API requests did not settle before navigation')), 20000);
    state.changed.add(check); check();
  });
}

export async function navigateReady(page,url){await waitForApiReads(page);return page.goto(url);}
export async function reloadReady(page){await waitForApiReads(page);return page.reload();}
