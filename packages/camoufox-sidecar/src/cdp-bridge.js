// Minimal Chrome DevTools Protocol (CDP) server backed by Playwright/Camoufox.
//
// The agent-browser Rust CLI speaks CDP exclusively. Camoufox is Firefox and
// speaks Juggler (via Playwright), so this module exposes the *subset* of CDP
// that the CLI's core command paths use and translates each command into the
// equivalent Playwright call against a Camoufox `Browser`.
//
// What it implements (enough for: open/navigate, eval, get url/title/content,
// click/type via Input, screenshot, snapshot via Accessibility, tab basics):
//   Browser.getVersion | Browser.close
//   Target.{setDiscoverTargets,getTargets,getTargetInfo,createTarget,
//           attachToTarget(flatten),closeTarget,activateTarget,setAutoAttach}
//   Page.{enable,getFrameTree,navigate,reload,getNavigationHistory,
//         captureScreenshot,getLayoutMetrics,bringToFront}  + lifecycle events
//   Runtime.{enable,evaluate,callFunctionOn,getProperties,releaseObject}
//   DOM.{enable,getDocument}            (minimal)
//   Input.{dispatchMouseEvent,dispatchKeyEvent,insertText}
//   Emulation.{setDeviceMetricsOverride,setUserAgentOverride}
//   Accessibility.{enable,getFullAXTree}   (approximated from a DOM walk)
//   Network.enable / *.disable / *.setXxx  (accepted as no-ops)
//
// Unimplemented methods return an empty result `{}` so optional domains do not
// abort a flow. Genuinely unsupported features should be surfaced by the CLI's
// own "not supported on this engine" messaging rather than here.

import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { buildAxTreeScript } from './ax-tree.js';

const PROTOCOL_VERSION = '1.3';

function guid() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

function debug(...args) {
  if (process.env.AGENT_BROWSER_DEBUG) {
    process.stderr.write('[camoufox-bridge] ' + args.join(' ') + '\n');
  }
}

/**
 * @param {object} deps
 * @param {import('playwright-core').Browser} deps.browser
 * @param {import('playwright-core').BrowserContext} deps.context
 * @param {number} deps.port
 * @param {string} deps.host
 * @returns {Promise<{ wsUrl: string, close: () => Promise<void> }>}
 */
export async function startCdpBridge({ browser, context, port, host = '127.0.0.1' }) {
  const browserGuid = guid();
  // targetId -> { page, type, contextId }
  const targets = new Map();
  // sessionId -> { targetId }
  const sessions = new Map();
  // objectId -> Playwright JSHandle (for Runtime.callFunctionOn / getProperties)
  const remoteObjects = new Map();
  // Active CDP websocket clients (normally just one — the Rust CLI).
  const clients = new Set();

  function pageTargetId(page) {
    for (const [id, t] of targets) if (t.page === page) return id;
    return null;
  }

  function registerPage(page, type = 'page') {
    const targetId = guid();
    targets.set(targetId, { page, type, contextId: browserGuid });
    wirePageEvents(targetId, page);
    return targetId;
  }

  // ---- Event emission -------------------------------------------------------

  function emit(method, params, sessionId) {
    const msg = sessionId ? { method, params, sessionId } : { method, params };
    const text = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  }

  /** Emit a page-scoped event to every session attached to that target. */
  function emitToPage(targetId, method, params) {
    for (const [sessionId, s] of sessions) {
      if (s.targetId === targetId) emit(method, params, sessionId);
    }
  }

  function wirePageEvents(targetId, page) {
    page.on('load', () => {
      emitToPage(targetId, 'Page.loadEventFired', { timestamp: nowSeconds() });
    });
    page.on('domcontentloaded', () => {
      emitToPage(targetId, 'Page.domContentEventFired', { timestamp: nowSeconds() });
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        emitToPage(targetId, 'Page.frameNavigated', {
          frame: frameDescriptor(page, frame),
        });
      }
    });
    page.on('close', () => {
      emit('Target.targetDestroyed', { targetId });
      targets.delete(targetId);
      for (const [sid, s] of sessions) if (s.targetId === targetId) sessions.delete(sid);
    });
  }

  function nowSeconds() {
    return Date.now() / 1000;
  }

  function frameDescriptor(page, frame) {
    return {
      id: pageTargetId(page) || browserGuid,
      loaderId: guid(),
      url: frame.url(),
      domainAndRegistry: '',
      securityOrigin: safeOrigin(frame.url()),
      mimeType: 'text/html',
      secureContextType: 'Secure',
      crossOriginIsolatedContextType: 'NotIsolated',
      gatedAPIFeatures: [],
    };
  }

  function safeOrigin(u) {
    try {
      return new URL(u).origin;
    } catch {
      return '';
    }
  }

  // ---- Command dispatch -----------------------------------------------------

  async function dispatch(method, params, sessionId) {
    const session = sessionId ? sessions.get(sessionId) : null;
    const target = session ? targets.get(session.targetId) : null;
    const page = target ? target.page : null;

    switch (method) {
      // ----- Browser ------------------------------------------------------
      case 'Browser.getVersion':
        return {
          protocolVersion: PROTOCOL_VERSION,
          product: 'Camoufox/Firefox',
          revision: '0',
          userAgent: await primaryUserAgent(context),
          jsVersion: '0',
        };
      case 'Browser.close':
        setTimeout(() => shutdown().catch(() => {}), 0);
        return {};

      // ----- Target -------------------------------------------------------
      case 'Target.setDiscoverTargets':
        for (const [targetId, t] of targets) {
          emit('Target.targetCreated', { targetInfo: targetInfo(targetId, t) });
        }
        return {};
      case 'Target.setAutoAttach':
        return {};
      case 'Target.getTargets':
        return {
          targetInfos: [...targets.entries()].map(([id, t]) => targetInfo(id, t)),
        };
      case 'Target.getTargetInfo': {
        const id = params.targetId || (target && session.targetId);
        const t = targets.get(id);
        if (!t) throw cdpError(`No target with id ${id}`);
        return { targetInfo: targetInfo(id, t) };
      }
      case 'Target.createTarget': {
        const newPage = await context.newPage();
        const targetId = registerPage(newPage);
        const url = params.url && params.url !== 'about:blank' ? params.url : null;
        if (url) {
          newPage.goto(url, { waitUntil: 'commit' }).catch((e) => debug('createTarget goto', e.message));
        }
        emit('Target.targetCreated', { targetInfo: targetInfo(targetId, targets.get(targetId)) });
        return { targetId };
      }
      case 'Target.attachToTarget': {
        const id = params.targetId;
        if (!targets.has(id)) throw cdpError(`No target with id ${id}`);
        const newSessionId = guid();
        sessions.set(newSessionId, { targetId: id });
        emit('Target.attachedToTarget', {
          sessionId: newSessionId,
          targetInfo: targetInfo(id, targets.get(id)),
          waitingForDebugger: false,
        });
        return { sessionId: newSessionId };
      }
      case 'Target.closeTarget': {
        const t = targets.get(params.targetId);
        if (t) await t.page.close().catch(() => {});
        return { success: true };
      }
      case 'Target.activateTarget': {
        const t = targets.get(params.targetId);
        if (t) await t.page.bringToFront().catch(() => {});
        return {};
      }
      case 'Target.detachFromTarget': {
        if (params.sessionId) sessions.delete(params.sessionId);
        return {};
      }

      // ----- Page ---------------------------------------------------------
      case 'Page.enable': {
        // Emit a synthetic execution context so consumers waiting on it proceed.
        if (page) {
          emit('Runtime.executionContextCreated', {
            context: { id: 1, origin: safeOrigin(page.url()), name: '', uniqueId: sessionId },
          }, sessionId);
        }
        return {};
      }
      case 'Page.getFrameTree': {
        requirePage(page);
        return {
          frameTree: { frame: frameDescriptor(page, page.mainFrame()), childFrames: [] },
        };
      }
      case 'Page.navigate': {
        requirePage(page);
        const loaderId = guid();
        try {
          await page.goto(params.url, { waitUntil: 'commit', referer: params.referrer });
        } catch (e) {
          return { frameId: session.targetId, loaderId, errorText: e.message };
        }
        return { frameId: session.targetId, loaderId };
      }
      case 'Page.reload': {
        requirePage(page);
        page.reload({ waitUntil: 'commit' }).catch((e) => debug('reload', e.message));
        return {};
      }
      case 'Page.getNavigationHistory': {
        requirePage(page);
        return {
          currentIndex: 0,
          entries: [{ id: 0, url: page.url(), userTypedURL: page.url(), title: await page.title(), transitionType: 'typed' }],
        };
      }
      case 'Page.navigateToHistoryEntry':
        return {};
      case 'Page.bringToFront': {
        if (page) await page.bringToFront().catch(() => {});
        return {};
      }
      case 'Page.captureScreenshot': {
        requirePage(page);
        const opts = { type: params.format === 'jpeg' ? 'jpeg' : 'png' };
        if (opts.type === 'jpeg' && typeof params.quality === 'number') opts.quality = params.quality;
        if (params.clip) {
          opts.clip = { x: params.clip.x, y: params.clip.y, width: params.clip.width, height: params.clip.height };
        } else if (params.captureBeyondViewport === false) {
          opts.fullPage = false;
        }
        const buf = await page.screenshot(opts);
        return { data: buf.toString('base64') };
      }
      case 'Page.getLayoutMetrics': {
        requirePage(page);
        const m = await page.evaluate(() => ({
          w: document.documentElement.scrollWidth,
          h: document.documentElement.scrollHeight,
          vw: window.innerWidth,
          vh: window.innerHeight,
          sx: window.scrollX,
          sy: window.scrollY,
        }));
        return {
          cssLayoutViewport: { pageX: m.sx, pageY: m.sy, clientWidth: m.vw, clientHeight: m.vh },
          cssVisualViewport: {
            offsetX: 0, offsetY: 0, pageX: m.sx, pageY: m.sy,
            clientWidth: m.vw, clientHeight: m.vh, scale: 1, zoom: 1,
          },
          cssContentSize: { x: 0, y: 0, width: m.w, height: m.h },
          layoutViewport: { pageX: m.sx, pageY: m.sy, clientWidth: m.vw, clientHeight: m.vh },
          visualViewport: {
            offsetX: 0, offsetY: 0, pageX: m.sx, pageY: m.sy,
            clientWidth: m.vw, clientHeight: m.vh, scale: 1, zoom: 1,
          },
          contentSize: { x: 0, y: 0, width: m.w, height: m.h },
        };
      }
      case 'Page.addScriptToEvaluateOnNewDocument': {
        requirePage(page);
        const id = guid();
        await page.context().addInitScript({ content: params.source }).catch(() => {});
        return { identifier: id };
      }

      // ----- Runtime ------------------------------------------------------
      case 'Runtime.enable': {
        if (page) {
          emit('Runtime.executionContextCreated', {
            context: { id: 1, origin: safeOrigin(page.url()), name: '', uniqueId: sessionId },
          }, sessionId);
        }
        return {};
      }
      case 'Runtime.evaluate':
        return runtimeEvaluate(page, params, remoteObjects);
      case 'Runtime.callFunctionOn':
        return runtimeCallFunctionOn(page, params, remoteObjects);
      case 'Runtime.getProperties':
        return runtimeGetProperties(params, remoteObjects);
      case 'Runtime.releaseObject':
        remoteObjects.delete(params.objectId);
        return {};
      case 'Runtime.releaseObjectGroup':
        return {};

      // ----- DOM (minimal) ------------------------------------------------
      case 'DOM.enable':
      case 'DOM.setNodeName':
        return {};
      case 'DOM.getDocument': {
        requirePage(page);
        return { root: { nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', childNodeCount: 1, children: [] } };
      }
      case 'DOM.resolveNode': {
        // Map a backendDOMNodeId (assigned during Accessibility.getFullAXTree)
        // back to a live element handle so callers can act on it.
        requirePage(page);
        const backendId = params.backendNodeId;
        const handle = await page.evaluateHandle(
          (id) => (window.__abx && window.__abx.byId ? window.__abx.byId.get(id) : null),
          backendId,
        );
        const isNull = await handle.evaluate((el) => el == null).catch(() => true);
        if (isNull) throw cdpError(`No node for backendNodeId ${backendId}`);
        const objectId = guid();
        remoteObjects.set(objectId, handle);
        return { object: { type: 'object', subtype: 'node', className: 'HTMLElement', description: 'node', objectId } };
      }
      case 'DOM.getBoxModel': {
        requirePage(page);
        // Accept any of objectId / backendNodeId / nodeId. backend & node ids
        // are the ids we assigned during Accessibility.getFullAXTree.
        let box;
        if (params.objectId && remoteObjects.has(params.objectId)) {
          box = await remoteObjects.get(params.objectId).evaluate(rectOf);
        } else {
          const id = params.backendNodeId ?? params.nodeId;
          if (id == null) throw cdpError('DOM.getBoxModel requires objectId, backendNodeId or nodeId');
          box = await page.evaluate((nid) => {
            const el = window.__abx && window.__abx.byId ? window.__abx.byId.get(nid) : null;
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          }, id);
          if (!box) throw cdpError(`No node for id ${id}`);
        }
        // CDP quads are integers; Camoufox/Firefox returns fractional rects.
        const x = Math.round(box.x);
        const y = Math.round(box.y);
        const w = Math.round(box.w);
        const h = Math.round(box.h);
        const quad = [x, y, x + w, y, x + w, y + h, x, y + h];
        return { model: { content: quad, padding: quad, border: quad, margin: quad, width: w, height: h } };
      }
      case 'DOM.scrollIntoViewIfNeeded': {
        const handle = params.objectId ? remoteObjects.get(params.objectId) : null;
        if (handle) await handle.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
        return {};
      }

      // ----- Input --------------------------------------------------------
      case 'Input.dispatchMouseEvent':
        await inputMouse(page, params);
        return {};
      case 'Input.dispatchKeyEvent':
        await inputKey(page, params);
        return {};
      case 'Input.insertText':
        requirePage(page);
        await page.keyboard.insertText(params.text);
        return {};

      // ----- Emulation ----------------------------------------------------
      case 'Emulation.setDeviceMetricsOverride': {
        if (page && params.width && params.height) {
          await page.setViewportSize({ width: params.width, height: params.height }).catch(() => {});
        }
        return {};
      }
      case 'Emulation.setUserAgentOverride':
        // Applied at context creation; per-page override is not supported in FF.
        return {};

      // ----- Accessibility (approximate) ----------------------------------
      case 'Accessibility.getFullAXTree': {
        requirePage(page);
        const nodes = await page.evaluate(buildAxTreeScript());
        return { nodes };
      }

      default:
        // Accept enable/disable/setXxx style calls (and other optional domains)
        // as no-ops so a single unsupported call does not abort a whole flow.
        debug('unhandled', method);
        return {};
    }
  }

  function targetInfo(targetId, t) {
    const page = t.page;
    return {
      targetId,
      type: t.type,
      title: '',
      url: page ? page.url() : 'about:blank',
      attached: [...sessions.values()].some((s) => s.targetId === targetId),
      canAccessOpener: false,
      browserContextId: t.contextId,
    };
  }

  async function primaryUserAgent(ctx) {
    try {
      const pages = ctx.pages();
      const p = pages[0] || (await ctx.newPage());
      return await p.evaluate(() => navigator.userAgent);
    } catch {
      return 'Mozilla/5.0 (Camoufox)';
    }
  }

  function requirePage(page) {
    if (!page) throw cdpError('No page session for this command');
  }

  // ---- Seed an initial target so getTargets is non-empty (like Chrome) ------
  {
    const existing = context.pages();
    const first = existing[0] || (await context.newPage());
    registerPage(first);
  }

  // ---- HTTP discovery + WebSocket server ------------------------------------

  const wsPath = `/devtools/browser/${browserGuid}`;
  // Resolved once the server binds (port may be 0 = OS-assigned).
  const boundPort = () => httpServer.address().port;
  const currentWsUrl = () => `ws://${host}:${boundPort()}${wsPath}`;

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        Browser: 'Camoufox/Firefox',
        'Protocol-Version': PROTOCOL_VERSION,
        'User-Agent': 'Camoufox',
        webSocketDebuggerUrl: currentWsUrl(),
      }));
    } else if (req.url === '/json' || req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([...targets.entries()].map(([id, t]) => ({
        id,
        type: t.type,
        title: '',
        url: t.page ? t.page.url() : 'about:blank',
        webSocketDebuggerUrl: `ws://${host}:${boundPort()}/devtools/page/${id}`,
      }))));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const { id, method, params = {}, sessionId } = msg;
      try {
        const result = await dispatch(method, params, sessionId);
        ws.send(JSON.stringify(sessionId ? { id, result, sessionId } : { id, result }));
      } catch (err) {
        const error = err && err.cdp ? err.cdp : { code: -32000, message: err && err.message ? err.message : String(err) };
        ws.send(JSON.stringify(sessionId ? { id, error, sessionId } : { id, error }));
      }
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
  });
  const actualPort = boundPort();
  const resolvedWsUrl = currentWsUrl();

  async function shutdown() {
    for (const ws of clients) try { ws.close(); } catch {}
    await new Promise((r) => wss.close(r));
    await new Promise((r) => httpServer.close(r));
    await browser.close().catch(() => {});
  }

  return { wsUrl: resolvedWsUrl, port: actualPort, close: shutdown };
}

// ---- CDP helpers (module-scope, pure) ---------------------------------------

function cdpError(message, code = -32000) {
  const e = new Error(message);
  e.cdp = { code, message };
  return e;
}

// Evaluated in-page against an element handle to read its viewport rect.
function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

function makeRemoteObject(value, remoteObjects, handle) {
  const t = typeof value;
  if (value === null) return { type: 'object', subtype: 'null', value: null };
  if (t === 'undefined') return { type: 'undefined' };
  if (t === 'string') return { type: 'string', value };
  if (t === 'number') return { type: 'number', value };
  if (t === 'boolean') return { type: 'boolean', value };
  if (handle) {
    const objectId = guid();
    remoteObjects.set(objectId, handle);
    return { type: 'object', objectId, className: 'Object', description: 'Object' };
  }
  return { type: t, value };
}

async function runtimeEvaluate(page, params, remoteObjects) {
  if (!page) throw cdpError('No page session for Runtime.evaluate');
  const { expression, returnByValue = false } = params;
  try {
    if (returnByValue) {
      const value = await page.evaluate((expr) => (0, eval)(expr), expression);
      return { result: jsonToRemote(value) };
    }
    // returnByValue == false: the caller wants a RemoteObject. For DOM nodes and
    // other non-serializable objects we must return an objectId backed by a live
    // handle (used by CSS-selector element resolution + callFunctionOn).
    const handle = await page.evaluateHandle((expr) => (0, eval)(expr), expression);
    const meta = await handle
      .evaluate((v) => {
        const t = typeof v;
        if (v === null) return { kind: 'null' };
        if (t === 'undefined') return { kind: 'undefined' };
        if (t === 'string' || t === 'number' || t === 'boolean') return { kind: 'primitive', t, v };
        const subtype = v instanceof Node ? 'node' : Array.isArray(v) ? 'array' : undefined;
        const className = (v && v.constructor && v.constructor.name) || 'Object';
        return { kind: 'object', subtype, className };
      })
      .catch(() => ({ kind: 'object', className: 'Object' }));

    if (meta.kind === 'undefined') return { result: { type: 'undefined' } };
    if (meta.kind === 'null') return { result: { type: 'object', subtype: 'null', value: null } };
    if (meta.kind === 'primitive') return { result: { type: meta.t, value: meta.v } };
    const objectId = guid();
    remoteObjects.set(objectId, handle);
    return {
      result: {
        type: 'object',
        subtype: meta.subtype,
        className: meta.className,
        description: meta.className,
        objectId,
      },
    };
  } catch (err) {
    return exceptionResult(err);
  }
}

async function runtimeCallFunctionOn(page, params, remoteObjects) {
  const { functionDeclaration, objectId, arguments: args = [], returnByValue = false } = params;
  const handle = objectId ? remoteObjects.get(objectId) : null;
  if (objectId && !handle) throw cdpError(`Unknown objectId ${objectId}`);
  // Resolve CDP argument descriptors into plain values. (Argument-by-objectId
  // is uncommon for this CLI; pass undefined if the handle is unknown.)
  const callValues = args.map((a) =>
    a && 'objectId' in a ? undefined : a ? a.value : undefined,
  );
  try {
    let value;
    if (handle) {
      // handle.evaluate(fn, arg) -> fn receives (thisObj, arg). Bind `this`.
      value = await handle.evaluate(
        (thisObj, payload) => {
          const fn = (0, eval)('(' + payload.src + ')');
          return fn.apply(thisObj, payload.values);
        },
        { src: functionDeclaration, values: callValues },
      );
    } else {
      requirePageOrThrow(page);
      value = await page.evaluate(
        (payload) => {
          const fn = (0, eval)('(' + payload.src + ')');
          return fn.apply(globalThis, payload.values);
        },
        { src: functionDeclaration, values: callValues },
      );
    }
    if (returnByValue) return { result: jsonToRemote(value) };
    return { result: makeRemoteObject(value, remoteObjects) };
  } catch (err) {
    return exceptionResult(err);
  }
}

function requirePageOrThrow(page) {
  if (!page) throw cdpError('No page session for Runtime.callFunctionOn');
}

async function runtimeGetProperties(params, remoteObjects) {
  const handle = remoteObjects.get(params.objectId);
  if (!handle) return { result: [] };
  try {
    const props = await handle.evaluate((obj) =>
      Object.entries(obj).slice(0, 100).map(([name, v]) => ({ name, value: v })),
    );
    return {
      result: props.map((p) => ({
        name: String(p.name),
        value: jsonToRemote(p.value),
        configurable: true,
        enumerable: true,
        writable: true,
      })),
    };
  } catch {
    return { result: [] };
  }
}

function jsonToRemote(value) {
  const t = typeof value;
  if (value === null) return { type: 'object', subtype: 'null', value: null };
  if (t === 'undefined') return { type: 'undefined' };
  if (t === 'object') return { type: 'object', value };
  return { type: t, value };
}

function exceptionResult(err) {
  const text = err && err.message ? err.message : String(err);
  return {
    result: { type: 'undefined' },
    exceptionDetails: {
      exceptionId: 1,
      text: 'Uncaught',
      lineNumber: 0,
      columnNumber: 0,
      exception: { type: 'object', subtype: 'error', className: 'Error', description: text },
    },
  };
}

async function inputMouse(page, params) {
  if (!page) throw cdpError('No page session for Input.dispatchMouseEvent');
  const { type, x, y, button = 'none', clickCount = 1 } = params;
  const btn = button === 'none' ? 'left' : button;
  if (type === 'mouseMoved') {
    await page.mouse.move(x, y);
  } else if (type === 'mousePressed') {
    await page.mouse.move(x, y);
    await page.mouse.down({ button: btn, clickCount });
  } else if (type === 'mouseReleased') {
    await page.mouse.up({ button: btn, clickCount });
  } else if (type === 'mouseWheel') {
    await page.mouse.wheel(params.deltaX || 0, params.deltaY || 0);
  }
}

async function inputKey(page, params) {
  if (!page) throw cdpError('No page session for Input.dispatchKeyEvent');
  const { type, key, text } = params;
  if (type === 'char' && text) {
    await page.keyboard.insertText(text);
    return;
  }
  const k = mapKey(key, params.code);
  if (!k) return;
  if (type === 'keyDown' || type === 'rawKeyDown') {
    await page.keyboard.down(k);
  } else if (type === 'keyUp') {
    await page.keyboard.up(k);
  }
}

// Map a CDP key name to a Playwright key name. They mostly align; cover the
// common control keys explicitly.
function mapKey(key, code) {
  if (!key) return code || null;
  const map = {
    Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    Escape: 'Escape', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ' ': 'Space',
  };
  return map[key] || key;
}
