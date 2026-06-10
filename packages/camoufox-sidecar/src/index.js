#!/usr/bin/env node
// Entry point for the Camoufox CDP-bridge sidecar.
//
// Spawned by the agent-browser Rust CLI when `--engine camoufox` is selected.
// Launches Camoufox via Playwright and serves a CDP-subset endpoint that the
// CLI connects to exactly as it would connect to Chrome.
//
// Usage:
//   node src/index.js --port 0 [--headed] [--proxy URL] [--user-agent UA]
//                     [--executable-path PATH] [--viewport WxH] [--locale L]
//                     [--ignore-https-errors] [--arg <firefox-arg>]...
//
// On success it prints a single line to stdout:
//   CAMOUFOX_READY <webSocketDebuggerUrl>
// and keeps running until SIGTERM/SIGINT or Browser.close.

import { launchCamoufox } from './camoufox-launch.js';
import { startCdpBridge } from './cdp-bridge.js';

function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: 0, headless: true, args: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--host': out.host = next(); break;
      case '--port': out.port = parseInt(next(), 10) || 0; break;
      case '--headed': out.headless = false; break;
      case '--headless': out.headless = true; break;
      case '--executable-path': out.executablePath = next(); break;
      case '--user-agent': out.userAgent = next(); break;
      case '--proxy': out.proxy = next(); break;
      case '--proxy-username': out.proxyUsername = next(); break;
      case '--proxy-password': out.proxyPassword = next(); break;
      case '--locale': out.locale = next(); break;
      case '--ignore-https-errors': out.ignoreHttpsErrors = true; break;
      case '--viewport': {
        const [w, h] = String(next()).split('x').map((n) => parseInt(n, 10));
        if (w && h) out.viewport = [w, h];
        break;
      }
      case '--arg': out.args.push(next()); break;
      default: break;
    }
  }
  return out;
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));

  let browser;
  let context;
  try {
    ({ browser, context } = await launchCamoufox(cfg));
  } catch (err) {
    process.stderr.write('CAMOUFOX_ERROR ' + (err && err.message ? err.message : String(err)) + '\n');
    process.exit(2);
  }

  const bridge = await startCdpBridge({
    browser,
    context,
    port: cfg.port,
    host: cfg.host,
  });

  // The Rust launcher watches for this line on stdout to learn the endpoint.
  process.stdout.write('CAMOUFOX_READY ' + bridge.wsUrl + '\n');

  const shutdown = async (code = 0) => {
    try {
      await bridge.close();
    } catch {
      // ignore
    }
    process.exit(code);
  };

  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  // Exit if the parent (Rust CLI) goes away and stdin closes.
  process.stdin.on('end', () => shutdown(0));
  browser.on('disconnected', () => shutdown(0));
}

main().catch((err) => {
  process.stderr.write('CAMOUFOX_ERROR ' + (err && err.stack ? err.stack : String(err)) + '\n');
  process.exit(1);
});
