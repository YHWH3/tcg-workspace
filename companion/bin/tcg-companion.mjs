#!/usr/bin/env node
// TCG Workspace Companion CLI — runs only on the user's own machine.
import { main } from '../lib/companion.mjs';

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  process.stderr.write('TCG Workspace Companion requires Node.js 22 or newer.\n');
  process.exit(1);
}
process.exitCode = await main(process.argv.slice(2));
