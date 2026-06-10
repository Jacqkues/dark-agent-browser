// Thin wrapper around camoufox-js that produces a Playwright Firefox `Browser`
// pre-configured with Camoufox's anti-fingerprinting patches.
//
// We use the lower-level `launchOptions()` API (rather than the high-level
// `Camoufox()` helper) so the bridge owns the Playwright `Browser` handle and
// can manage contexts/pages itself — that maps cleanly onto CDP "targets".

import { firefox } from 'playwright-core';

/**
 * @typedef {Object} CamoufoxConfig
 * @property {boolean} [headless]            Run without a visible window (default true).
 * @property {string}  [executablePath]      Override the Camoufox binary path.
 * @property {string}  [userAgent]           Force a specific User-Agent string.
 * @property {string}  [proxy]               Proxy server URL (http://host:port or socks5://...).
 * @property {string}  [proxyUsername]       Proxy auth username.
 * @property {string}  [proxyPassword]       Proxy auth password.
 * @property {[number, number]} [viewport]   [width, height] of the initial viewport.
 * @property {string}  [locale]              BCP-47 locale (e.g. "en-US").
 * @property {boolean} [ignoreHttpsErrors]   Ignore TLS errors.
 * @property {string[]} [args]               Extra Firefox CLI args.
 */

/**
 * Resolve camoufox-js. Kept lazy so `--help` / fetch flows don't hard-require it.
 * @returns {Promise<{ launchOptions: Function }>}
 */
async function loadCamoufox() {
  try {
    return await import('camoufox-js');
  } catch (err) {
    throw new Error(
      'camoufox-js is not installed. Run `agent-browser install` (downloads Camoufox) ' +
        'or `pnpm install` inside packages/camoufox-sidecar.\nUnderlying error: ' +
        (err && err.message ? err.message : String(err)),
    );
  }
}

/**
 * Launch Camoufox and return the Playwright Browser plus a default context.
 * @param {CamoufoxConfig} config
 * @returns {Promise<{ browser: import('playwright-core').Browser, context: import('playwright-core').BrowserContext }>}
 */
export async function launchCamoufox(config = {}) {
  const { launchOptions } = await loadCamoufox();

  // Map our flat config onto camoufox-js's launchOptions() input. camoufox-js
  // injects the fetched Camoufox executablePath, firefoxUserPrefs and env that
  // carry the fingerprint spoofing, so we must NOT override executablePath
  // unless the caller explicitly provided one.
  const camoufoxInput = {
    headless: config.headless !== false,
  };
  if (config.executablePath) camoufoxInput.executablePath = config.executablePath;
  if (config.proxy) {
    camoufoxInput.proxy = { server: config.proxy };
    if (config.proxyUsername) camoufoxInput.proxy.username = config.proxyUsername;
    if (config.proxyPassword) camoufoxInput.proxy.password = config.proxyPassword;
  }
  if (config.locale) camoufoxInput.locale = config.locale;
  if (config.args && config.args.length) camoufoxInput.args = config.args;

  const opts = await launchOptions(camoufoxInput);
  const browser = await firefox.launch(opts);

  const contextOptions = {};
  if (config.userAgent) contextOptions.userAgent = config.userAgent;
  if (config.ignoreHttpsErrors) contextOptions.ignoreHTTPSErrors = true;
  if (config.viewport && config.viewport.length === 2) {
    contextOptions.viewport = { width: config.viewport[0], height: config.viewport[1] };
  }
  // camoufox already injects proxy at the browser level via launchOptions; do
  // not duplicate it on the context.

  const context = await browser.newContext(contextOptions);
  return { browser, context };
}
