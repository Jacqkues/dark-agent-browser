# @agent-browser/camoufox-sidecar

A CDP-over-WebSocket bridge that lets the `agent-browser` CLI drive
[Camoufox](https://camoufox.com/) — a stealth, anti-fingerprinting browser built
on Firefox.

## Why a sidecar?

`agent-browser` speaks **CDP (Chrome DevTools Protocol)** to every browser it
controls. Camoufox is Firefox-based and speaks **Juggler via Playwright**; it
deliberately avoids CDP because CDP is a common bot-detection signal. The two are
protocol-incompatible, so we cannot point the CLI's CDP client straight at
Camoufox.

This sidecar bridges the gap. It:

1. Launches Camoufox through Playwright (`camoufox-js` provides the patched
   Firefox build + fingerprint spoofing).
2. Serves an HTTP discovery endpoint (`/json/version`) and a CDP WebSocket,
   exactly like Chrome's remote debugging interface.
3. Translates the subset of CDP the CLI uses into Playwright calls against
   Camoufox.

From the CLI's perspective Camoufox looks just like any other CDP browser — the
same integration shape as the bundled Lightpanda engine.

```
agent-browser (Rust, CDP client)
        │  CDP over ws://127.0.0.1:<port>
        ▼
camoufox-sidecar (this package)
        │  Playwright / Juggler
        ▼
Camoufox (Firefox + anti-fingerprint patches)
```

## Usage

You normally don't run this directly — the CLI spawns it when you pass
`--engine camoufox`. First-time setup downloads Camoufox:

```bash
agent-browser install camoufox
agent-browser --engine camoufox open https://example.com
agent-browser snapshot
```

### Version compatibility (important)

`playwright-core` is **pinned to `1.51.1`** on purpose. The Playwright Firefox
client must match the Camoufox Firefox base (currently FF135). Newer Playwright
(e.g. 1.60) ships a newer Juggler protocol client that mismatches the Camoufox
build and **crashes when a page raises an uncaught JS error** (common on
anti-bot pages), aborting navigation. If you bump Camoufox to a newer Firefox
base, bump `playwright-core` to the matching minor and re-test.

### Running the sidecar standalone

```bash
pnpm install
pnpm fetch                      # download the Camoufox browser build
node src/index.js --port 0      # prints: CAMOUFOX_READY ws://127.0.0.1:<port>/devtools/browser/<id>
```

Flags: `--port`, `--host`, `--headed`/`--headless`, `--proxy`,
`--proxy-username`, `--proxy-password`, `--user-agent`, `--executable-path`,
`--viewport WxH`, `--locale`, `--ignore-https-errors`, `--arg <firefox-arg>`.

### Tests

```bash
pnpm test:bridge   # validates the CDP handshake against a mock page (no browser needed)
```

## Implemented CDP surface

The bridge implements the subset of CDP that `agent-browser`'s core commands
use. Verified working against real Camoufox:

| Capability | CDP used | Status |
| --- | --- | --- |
| open / navigate | `Target.*`, `Page.navigate`, lifecycle events | ✅ |
| get url / title / content | `Runtime.evaluate` | ✅ |
| eval | `Runtime.evaluate` | ✅ |
| snapshot | `Accessibility.getFullAXTree` (approximated from a DOM walk) | ✅ |
| screenshot (viewport + full page) | `Page.captureScreenshot` (`fullPage` via Playwright), `Page.getLayoutMetrics` | ✅ |
| click (by `@ref` and CSS selector) | `DOM.resolveNode` / `getBoxModel`, `Input.dispatchMouseEvent` | ✅ |
| fill / type | `Runtime.callFunctionOn`, `Input.dispatchKeyEvent` | ✅ |
| close | `Browser.close` | ✅ |

### Not yet ported / experimental

These rely on deeper CDP domains that aren't translated yet; they may error or
no-op on the Camoufox engine and fall back to the CLI's standard "not supported"
handling:

- Full DOM domain (`DOM.querySelectorAll`, mutation events) — only the minimal
  pieces needed for element resolution are implemented.
- Full-page screenshots use Playwright's `fullPage` (reliable height), but
  Firefox caps a single screenshot at ~4096px tall; pages taller than that are
  captured up to the cap.
- Network interception / mocking, request/response events.
- `Page.printToPDF` (Firefox PDF generation differs).
- CPU/heap profiling, tracing, video/HAR recording.
- Multi-tab and cross-origin iframe session routing (single page works; extra
  tabs are created but advanced routing is untested).
- Chrome extensions, Chrome user-data profiles, storage-state import.

The accessibility tree is an **approximation** built from a DOM walk (implicit +
ARIA roles, accessible names). It covers the roles/names the snapshot renderer
keys on but is not a full ARIA computation.

## License

Apache-2.0 (same as agent-browser).
