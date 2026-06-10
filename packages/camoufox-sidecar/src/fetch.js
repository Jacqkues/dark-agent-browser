#!/usr/bin/env node
// Downloads the Camoufox browser build (and its bundled fingerprint data) via
// camoufox-js. Invoked by `agent-browser install` and `pnpm --filter
// @agent-browser/camoufox-sidecar fetch`.
//
// camoufox-js exposes its downloader differently across versions; try the
// known entry points and fall back to spawning its bundled CLI.

import { spawnSync } from 'node:child_process';

async function tryProgrammatic() {
  const mod = await import('camoufox-js').catch(() => null);
  if (!mod) return false;
  // Newer camoufox-js exports a fetch/installer helper.
  const candidate =
    mod.fetchBrowser || mod.fetch || mod.install || (mod.default && mod.default.fetch);
  if (typeof candidate === 'function') {
    await candidate();
    return true;
  }
  return false;
}

function trySpawnCli() {
  // camoufox-js ships a `camoufox-js` bin that supports `fetch`.
  const res = spawnSync('npx', ['--no-install', 'camoufox-js', 'fetch'], {
    stdio: 'inherit',
  });
  return res.status === 0;
}

async function main() {
  process.stdout.write('Downloading Camoufox browser…\n');
  try {
    if (await tryProgrammatic()) {
      process.stdout.write('Camoufox is ready.\n');
      return;
    }
  } catch (err) {
    process.stderr.write('Programmatic fetch failed: ' + (err && err.message) + '\n');
  }

  if (trySpawnCli()) {
    process.stdout.write('Camoufox is ready.\n');
    return;
  }

  process.stderr.write(
    'Could not download Camoufox automatically.\n' +
      'Install dependencies first (pnpm install) then run:\n' +
      '  npx camoufox-js fetch\n',
  );
  process.exit(1);
}

main();
