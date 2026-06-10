// Validates the CDP bridge's protocol layer (discovery + Target handshake +
// Runtime.evaluate + Page.navigate) against a mock Playwright page, so the
// translation logic can be tested without downloading Camoufox.
//
// Run: node test/handshake.test.js   (exit code 0 = pass)

import http from 'node:http';
import assert from 'node:assert';
import { WebSocket } from 'ws';
import { startCdpBridge } from '../src/cdp-bridge.js';

// ---- Minimal Playwright test doubles ---------------------------------------

function makeHandle(value) {
  return {
    evaluate: async (fn, arg) => fn(value, arg),
    jsonValue: async () => value,
  };
}

function makePage() {
  const listeners = {};
  let currentUrl = 'about:blank';
  return {
    _emit(event, ...a) { (listeners[event] || []).forEach((f) => f(...a)); },
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    url: () => currentUrl,
    title: async () => 'Mock Title',
    mainFrame() { return { url: () => currentUrl }; },
    async goto(url) { currentUrl = url; return null; },
    async evaluate(fn, arg) { return typeof fn === 'function' ? fn(arg) : undefined; },
    async evaluateHandle(fn, arg) { return makeHandle(typeof fn === 'function' ? fn(arg) : undefined); },
    async screenshot() { return Buffer.from('fakepng'); },
    async bringToFront() {},
    async setViewportSize() {},
    async close() { this._emit('close'); },
    context() { return { addInitScript: async () => {} }; },
    mouse: { move: async () => {}, down: async () => {}, up: async () => {}, wheel: async () => {} },
    keyboard: { down: async () => {}, up: async () => {}, insertText: async () => {} },
  };
}

function makeContext() {
  const page = makePage();
  return {
    _page: page,
    pages() { return [page]; },
    async newPage() { return makePage(); },
  };
}

function makeBrowser() {
  return { on() {}, async close() {} };
}

// ---- CDP client helper ------------------------------------------------------

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  function send(method, params = {}, sessionId) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  return { ready, send, close: () => ws.close() };
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

// ---- Test run ---------------------------------------------------------------

async function run() {
  const bridge = await startCdpBridge({
    browser: makeBrowser(),
    context: makeContext(),
    port: 0,
    host: '127.0.0.1',
  });
  const { port } = bridge;
  console.log('bridge listening, ws =', bridge.wsUrl);

  // 1. HTTP discovery
  const version = await httpGetJson(`http://127.0.0.1:${port}/json/version`);
  assert.ok(version.webSocketDebuggerUrl, '/json/version exposes webSocketDebuggerUrl');
  assert.equal(version.webSocketDebuggerUrl, bridge.wsUrl);
  console.log('✓ /json/version discovery');

  const client = cdpClient(bridge.wsUrl);
  await client.ready;

  // 2. Browser.getVersion
  const v = await client.send('Browser.getVersion');
  assert.match(v.product, /Camoufox/);
  console.log('✓ Browser.getVersion');

  // 3. Target discovery handshake (mirrors discover_and_attach_targets)
  await client.send('Target.setDiscoverTargets', { discover: true });
  const { targetInfos } = await client.send('Target.getTargets');
  assert.ok(targetInfos.length >= 1, 'has at least one page target');
  assert.equal(targetInfos[0].type, 'page');
  console.log('✓ Target.getTargets returns a page target');

  const { sessionId } = await client.send('Target.attachToTarget', {
    targetId: targetInfos[0].targetId,
    flatten: true,
  });
  assert.ok(sessionId, 'attachToTarget returns a flat sessionId');
  console.log('✓ Target.attachToTarget (flatten)');

  // 4. Runtime.evaluate on the page session
  await client.send('Runtime.enable', {}, sessionId);
  const ev = await client.send(
    'Runtime.evaluate',
    { expression: '1 + 1', returnByValue: true, awaitPromise: true },
    sessionId,
  );
  assert.equal(ev.result.value, 2, 'Runtime.evaluate returns by value');
  console.log('✓ Runtime.evaluate (returnByValue)');

  // 5. Page.navigate returns a loaderId so the CLI will await lifecycle
  await client.send('Page.enable', {}, sessionId);
  const nav = await client.send('Page.navigate', { url: 'https://example.com' }, sessionId);
  assert.ok(nav.loaderId, 'Page.navigate returns a loaderId');
  console.log('✓ Page.navigate');

  // 6. Unknown method is a no-op (returns {})
  const noop = await client.send('Network.enable', {}, sessionId);
  assert.deepEqual(noop, {});
  console.log('✓ unknown/optional method no-op');

  client.close();
  await bridge.close();
  console.log('\nALL BRIDGE HANDSHAKE TESTS PASSED');
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
