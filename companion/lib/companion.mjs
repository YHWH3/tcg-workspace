// Wires the store, ChatGPT auth, OpenAI client, Workspace auth and MCP client
// together and implements the CLI commands. Test seams (fetch, clock, browser
// opener, config dir, sleep, I/O) are constructor-injected only; endpoints are
// constants and are never overridable by environment variables.
import { createInterface } from 'node:readline';
import { MANAGE_USAGE_HINT } from './constants.mjs';
import { buildToolset, runTurn } from './chat.mjs';
import { CompanionError, ResponsesError } from './errors.mjs';
import { OpenAIClient } from './openai.mjs';
import { ChatGPTAuth, planUsageActive } from './siwc.mjs';
import { CompanionStore, publicAccount } from './store.mjs';
import { redact } from './util.mjs';
import { McpClient, WorkspaceAuth } from './workspace.mjs';

export const WELCOME = 'You’re using your ChatGPT plan. Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings (Settings → Usage). [Got it]';

export class Companion {
  /**
   * @param {{configDir?:string, fetch?:typeof fetch, now?:()=>number, openBrowser?:(url:string)=>Promise<void>,
   *   sleep?:(ms:number)=>Promise<void>, lockWait?:(ms:number)=>Promise<void>,
   *   stdout?:{write:(s:string)=>void}, stderr?:{write:(s:string)=>void}, stdin?:NodeJS.ReadableStream}} [deps]
   */
  constructor(deps = {}) {
    this.out = deps.stdout ?? process.stdout;
    this.errOut = deps.stderr ?? process.stderr;
    this.stdin = deps.stdin ?? process.stdin;
    this.store = new CompanionStore({ configDir: deps.configDir, now: deps.now });
    const log = (m) => this.errOut.write(`${redact(m)}\n`);
    this.log = log;
    this.chatgpt = new ChatGPTAuth({ store: this.store, fetch: deps.fetch, now: deps.now, openBrowser: deps.openBrowser, log, sleep: deps.sleep, lockWait: deps.lockWait });
    this.openai = new OpenAIClient({ auth: this.chatgpt, fetch: deps.fetch, sleep: deps.sleep });
    this.workspace = new WorkspaceAuth({ store: this.store, fetch: deps.fetch, now: deps.now, openBrowser: deps.openBrowser, log, lockWait: deps.lockWait });
    this.mcp = new McpClient({ auth: this.workspace, fetch: deps.fetch });
  }

  print(s) { this.out.write(`${s}\n`); }

  activeLabelOrThrow(label) {
    const l = label ?? this.store.activeLabel();
    if (!l) throw new CompanionError('no_account', 'No ChatGPT account selected. Run `tcg-companion login`.');
    return l;
  }

  async login(opts = {}) {
    const r = await this.chatgpt.login({ account: opts.account, label: opts.label, port: opts.port, reconsent: opts.enablePlan });
    this.print(`Signed in as ${r.account.label}${r.account.email ? ` (${r.account.email})` : ''}.`);
    this.print(`ChatGPT plan usage: ${r.planUsage}`);
    if (r.planUsage === 'disabled') {
      this.print('The chatgpt.tokens.use.direct permission was not granted, so the companion will not run inference. ' +
        `Run \`tcg-companion login --account "${r.account.label}" --enable-plan\` to grant it. No other billing path is used.`);
    }
    if (r.showWelcome) this.print(WELCOME);
    return r;
  }

  accounts() {
    const active = this.store.activeLabel();
    const list = this.store.listAccounts().map(publicAccount);
    if (!list.length) this.print('No saved ChatGPT accounts. Run `tcg-companion login`.');
    for (const a of list) {
      this.print(`${a.label === active ? '*' : ' '} ${a.label}${a.email ? `  <${a.email}>` : ''}  plan usage: ${a.plan_usage}${a.signed_in ? '' : '  (signed out)'}`);
    }
    return list;
  }

  use(label) {
    this.store.setActive(label);
    this.print(`Active ChatGPT account: ${label}`);
  }

  async models(label) {
    const l = this.activeLabelOrThrow(label);
    const models = await this.openai.listModels(l);
    this.print(`Models available to ${l} (not every model is available to every account):`);
    for (const m of models) this.print(`  ${m.display_name}  [${m.slug}]`);
    return models;
  }

  async connect(origin, opts = {}) {
    const r = await this.workspace.connect(origin, opts);
    this.print(`Connected to Workspace ${r.origin}.`);
    return r;
  }

  async logout(label) {
    const l = this.activeLabelOrThrow(label);
    const r = await this.chatgpt.logout(l);
    this.print(r.message);
    return r;
  }

  statusLine(label, modelName) {
    const rec = this.store.readAccount(label);
    return `ChatGPT account: ${label}${rec?.email ? ` (${rec.email})` : ''} · Model: ${modelName} · ChatGPT plan usage: ${planUsageActive(rec) ? 'active' : 'disabled'}\n${MANAGE_USAGE_HINT}`;
  }

  describeError(e) {
    if (e instanceof ResponsesError) {
      const lines = [e.message];
      if (e.kind === 'usage_limit') lines.push('Requests are paused. Review your plan or this app’s limit in ChatGPT Settings → Usage.');
      return lines.join('\n');
    }
    return redact(e?.message ?? String(e));
  }

  /**
   * Interactive chat REPL. Returns when the user types /exit or input ends.
   * @param {{label?:string, model?:string}} [opts]
   */
  async chat(opts = {}) {
    const label = this.activeLabelOrThrow(opts.label);
    if (!planUsageActive(this.store.readAccount(label))) {
      throw new CompanionError('plan_usage_disabled', `ChatGPT plan usage is disabled for "${label}". Run \`tcg-companion login --account "${label}" --enable-plan\`.`);
    }
    const models = await this.openai.listModels(label);
    const settings = this.store.settings();
    let model = opts.model ?? settings.model;
    if (!model || !models.some((m) => m.slug === model)) model = models[0]?.slug;
    if (!model) throw new CompanionError('no_model', 'No models are listed for this account.');
    await this.mcp.initialize();
    const toolset = buildToolset(await this.mcp.listTools());
    const display = models.find((m) => m.slug === model)?.display_name ?? model;
    this.print(this.statusLine(label, display));
    this.print(`Workspace: ${this.mcp.origin} · ${toolset.map.size} tools · Using ChatGPT plan · type /exit to quit, /model <slug> to switch`);
    const history = [];
    let paused = false;
    const rl = createInterface({ input: this.stdin, terminal: false });
    for await (const line of rl) {
      const text = line.trim();
      if (!text) continue;
      if (text === '/exit' || text === '/quit') break;
      if (text.startsWith('/model')) {
        const slug = text.split(/\s+/)[1];
        if (models.some((m) => m.slug === slug)) { model = slug; this.store.saveSettings({ ...settings, model }); this.print(`Model: ${slug}`); }
        else this.print(`Unknown model. Available: ${models.map((m) => m.slug).join(', ')}`);
        continue;
      }
      if (paused) { this.print(`Paused: ChatGPT plan usage limit reached. ${MANAGE_USAGE_HINT}`); continue; }
      const mark = history.length;
      try {
        await runTurn({ openai: this.openai, label, model, mcp: this.mcp, toolset, history, userText: text, write: (s) => this.out.write(s) });
      } catch (e) {
        if (e instanceof ResponsesError && e.kind === 'usage_limit') paused = true;
        this.print(`\n${this.describeError(e)}`);
        history.length = mark; // drop the failed turn so replayed history stays consistent
      }
    }
    rl.close();
  }
}

/** Parse argv into {cmd, args, flags}. */
export function parseArgs(argv) {
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (['enable-plan', 'help'].includes(k)) flags[k] = true;
      else flags[k] = argv[++i];
    } else args.push(a);
  }
  return { cmd: args.shift(), args, flags };
}

export const USAGE = `Usage: node companion/bin/tcg-companion.mjs <command> [options]

  login [--label <name>] [--account <label>] [--enable-plan] [--port <n>]
                       Continue with ChatGPT (new account, or reauthorize --account)
  accounts             List saved ChatGPT accounts (* = active)
  use <label>          Switch the active ChatGPT account
  models               List models available to the active account
  connect <origin>     Connect a TCG Workspace (OAuth; you choose spaces in the browser)
  chat [--model <slug>]  Chat with your Workspace using your ChatGPT plan
  logout [<label>]     Sign out (revokes the refresh token, clears local tokens)

  Global: --config-dir <dir>  (default ~/.config/tcg-workspace-companion)`;

export async function main(argv, deps = {}) {
  const { cmd, args, flags } = parseArgs(argv);
  if (!cmd || flags.help || cmd === 'help') { (deps.stdout ?? process.stdout).write(`${USAGE}\n`); return 0; }
  const c = new Companion({ ...deps, configDir: flags['config-dir'] ?? deps.configDir });
  try {
    const port = flags.port ? Number(flags.port) : undefined;
    switch (cmd) {
      case 'login': await c.login({ label: flags.label, account: flags.account, enablePlan: Boolean(flags['enable-plan']), port }); break;
      case 'accounts': c.accounts(); break;
      case 'use': if (!args[0]) throw new CompanionError('usage', 'use <label>'); c.use(args[0]); break;
      case 'models': await c.models(flags.account); break;
      case 'connect': if (!args[0]) throw new CompanionError('usage', 'connect <origin>'); await c.connect(args[0], { port }); break;
      case 'chat': await c.chat({ label: flags.account, model: flags.model }); break;
      case 'logout': await c.logout(args[0]); break;
      default: throw new CompanionError('usage', `Unknown command "${cmd}".\n${USAGE}`);
    }
    return 0;
  } catch (e) {
    (deps.stderr ?? process.stderr).write(`Error: ${c.describeError(e)}\n`);
    return 1;
  }
}
