// Builds an approximate Chrome-CDP-shaped accessibility tree from a DOM walk.
//
// Chrome's `Accessibility.getFullAXTree` returns a computed AX tree that the
// CLI's snapshot.rs parses into roles + accessible names + backendDOMNodeIds.
// Firefox/Camoufox does not expose that exact CDP tree, so we approximate it in
// page script: walk the DOM, assign each element a stable id (also stored on
// `window.__abx.byId` so `DOM.resolveNode` can map a backendDOMNodeId back to a
// live element for clicks), and compute an implicit/ARIA role + accessible name.
//
// This is intentionally a *subset*: it covers the roles and names the snapshot
// renderer keys on, not the full ARIA computation. Marked experimental.

/**
 * @returns {string} A self-contained JS expression that evaluates, in the page,
 * to an array of CDP-style AXNode objects.
 */
export function buildAxTreeScript() {
  return `(() => {
    const root = window.__abx || (window.__abx = {});
    root.byId = new Map();
    let counter = 0;
    const nodes = [];

    const IMPLICIT_ROLE = {
      A: (el) => (el.hasAttribute('href') ? 'link' : 'generic'),
      BUTTON: () => 'button',
      INPUT: (el) => {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
        if (t === 'range') return 'slider';
        if (t === 'search') return 'searchbox';
        if (t === 'hidden') return 'none';
        return 'textbox';
      },
      TEXTAREA: () => 'textbox',
      SELECT: () => 'combobox',
      IMG: () => 'image',
      H1: () => 'heading', H2: () => 'heading', H3: () => 'heading',
      H4: () => 'heading', H5: () => 'heading', H6: () => 'heading',
      NAV: () => 'navigation',
      MAIN: () => 'main',
      HEADER: () => 'banner',
      FOOTER: () => 'contentinfo',
      ASIDE: () => 'complementary',
      ARTICLE: () => 'article',
      SECTION: () => 'region',
      UL: () => 'list', OL: () => 'list', LI: () => 'listitem',
      TABLE: () => 'table', TR: () => 'row', TD: () => 'cell', TH: () => 'columnheader',
      FORM: () => 'form',
      LABEL: () => 'LabelText',
      P: () => 'paragraph',
    };

    function roleOf(el) {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit.trim().split(/\\s+/)[0];
      const fn = IMPLICIT_ROLE[el.tagName];
      return fn ? fn(el) : 'generic';
    }

    function isHidden(el) {
      if (el.getAttribute('aria-hidden') === 'true') return true;
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return true;
      return false;
    }

    function accessibleName(el, role) {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria.trim();
      const labelledby = el.getAttribute('aria-labelledby');
      if (labelledby) {
        const ref = document.getElementById(labelledby);
        if (ref) return (ref.textContent || '').trim();
      }
      if (el.tagName === 'IMG') return (el.getAttribute('alt') || '').trim();
      if (el.tagName === 'INPUT') {
        const ph = el.getAttribute('placeholder');
        if (ph) return ph.trim();
        if (el.labels && el.labels.length) return (el.labels[0].textContent || '').trim();
        const v = el.getAttribute('value');
        if (v && role === 'button') return v.trim();
        return '';
      }
      // For interactive/leaf/heading roles, use trimmed text content.
      const NAME_FROM_CONTENT = new Set([
        'link', 'button', 'heading', 'listitem', 'cell', 'columnheader',
        'menuitem', 'option', 'tab', 'paragraph', 'LabelText',
      ]);
      if (NAME_FROM_CONTENT.has(role)) {
        return (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
      }
      return '';
    }

    function walk(el) {
      if (!(el instanceof Element)) return null;
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') return null;
      const ignored = isHidden(el);
      const role = roleOf(el);
      const id = String(++counter);
      root.byId.set(counter, el);

      const childIds = [];
      for (const child of el.children) {
        const childId = walk(child);
        if (childId) childIds.push(childId);
      }

      const props = [];
      if (el.matches('a[href], button, input, select, textarea, [role="button"], [role="link"], [tabindex]')) {
        props.push({ name: 'focusable', value: { type: 'boolean', value: true } });
      }

      const node = {
        nodeId: id,
        ignored,
        role: { type: 'role', value: role },
        name: { type: 'computedString', value: accessibleName(el, role) },
        childIds,
        backendDOMNodeId: counter,
      };
      if (props.length) node.properties = props;
      nodes.push(node);
      return id;
    }

    walk(document.body || document.documentElement);
    // Chrome returns nodes parent-before-child; reverse so roots come first.
    return nodes.reverse();
  })()`;
}
