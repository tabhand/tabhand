// Turns Chrome's accessibility tree into a compact outline an agent can read. Elements the agent
// can act on get a ref (e123) that browser_click and browser_type accept. A ref is the element's
// DOM backend node id, so it stays valid until the page navigates or the element is removed.
// Pages also build controls from plain elements (a div with a click handler) that the tree has no
// role for; those the caller found clickable show as "clickable", with a ref too, and so do the
// ones that can be dragged ("draggable"), for browser_drag to name.

const ACTIONABLE = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);
const HAS_VALUE = new Set(['combobox', 'searchbox', 'slider', 'spinbutton', 'textbox']);
// Wrappers that add nothing for the reader: their children are shown in their place.
const TRANSPARENT = new Set(['generic', 'none', 'presentation', 'LineBreak', 'InlineTextBox', 'LabelText', 'Section']);
const STATES = ['checked', 'expanded', 'selected', 'pressed', 'disabled', 'required', 'invalid'];
const MAX_CHARS = 40_000;

const clean = (text, max = 150) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

/** The text inside a node, for naming a clickable element that has no name of its own. An icon's
 * alt text often repeats the label next to it; that's said once. */
function textInside(node, byId, max = 150) {
  const parts = [];
  let length = 0;
  const visit = (current) => {
    if (!current || length > max) return;
    const role = current.role?.value ?? '';
    if (role === 'StaticText' || ((role === 'image' || role === 'img') && current.name?.value)) {
      const part = clean(current.name?.value);
      if (part && part !== parts.at(-1)) {
        parts.push(part);
        length += part.length + 1;
      }
      return;
    }
    for (const id of current.childIds ?? []) visit(byId.get(id));
  };
  visit(node);
  return clean(parts.join(' '), max);
}

const focusable = (node) => (node.properties ?? []).some((p) => p.name === 'focusable' && p.value?.value === true);

/** clickable, draggable: DOM backend node ids of plain elements the page made clickable, or draggable. */
export function renderSnapshot(nodes, { clickable = new Set(), draggable = new Set() } = {}) {
  if (!nodes?.length) return '(empty page)';
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  // Whether anything inside a node has a ref of its own: then that's what to click, and a card
  // around it needn't be one more clickable.
  const refInside = new Map();
  const hasRefInside = (node) => {
    if (!refInside.has(node.nodeId)) {
      refInside.set(
        node.nodeId,
        (node.childIds ?? []).some((id) => {
          const child = byId.get(id);
          return child && (ACTIONABLE.has(child.role?.value) || focusable(child) || hasRefInside(child));
        }),
      );
    }
    return refInside.get(node.nodeId);
  };
  const lines = [];
  let size = 0;
  let truncated = false;

  const push = (line) => {
    if (truncated) return;
    if (size + line.length > MAX_CHARS) {
      truncated = true;
      return;
    }
    lines.push(line);
    size += line.length + 1;
  };

  // inRef: inside an element that already has a ref, so clicking that one does it.
  const walk = (node, depth, parentName, inRef = false) => {
    if (!node || truncated) return;
    const role = node.role?.value ?? '';
    const name = clean(node.name?.value);
    const children = (node.childIds ?? []).map((id) => byId.get(id));
    const pad = '  '.repeat(depth);

    // A focusable one too: without a name, the outline would pass over it as a mere wrapper.
    const kind = clickable.has(node.backendDOMNodeId) ? 'clickable' : draggable.has(node.backendDOMNodeId) ? 'draggable' : null;
    if (!inRef && kind && !ACTIONABLE.has(role) && role !== 'StaticText' && !hasRefInside(node)) {
      const label = name || textInside(node, byId, 80);
      if (label) {
        push(`${pad}- ${kind} "${label}" [ref=e${node.backendDOMNodeId}]`);
        for (const child of children) walk(child, depth + 1, label, true);
        return;
      }
    }
    if (node.ignored || role === 'RootWebArea' || (TRANSPARENT.has(role) && !name)) {
      for (const child of children) walk(child, depth, parentName, inRef);
      return;
    }
    if (role === 'StaticText') {
      if (name && !parentName.includes(name)) push(`${pad}- text: ${name}`);
      return;
    }
    if ((role === 'image' || role === 'img') && !name) return;

    const properties = new Map((node.properties ?? []).map((p) => [p.name, p.value?.value]));
    let line = `${pad}- ${role}${name ? ` "${name}"` : ''}`;
    if (properties.has('level')) line += ` [level=${properties.get('level')}]`;
    for (const state of STATES) {
      const value = properties.get(state);
      if (value !== undefined && value !== false && value !== 'false') line += value === true || value === 'true' ? ` [${state}]` : ` [${state}=${value}]`;
    }
    if (HAS_VALUE.has(role) && node.value?.value !== undefined && node.value.value !== '') {
      line += ` value="${clean(node.value.value, 100)}"`;
    }
    const hasRef = Boolean(node.backendDOMNodeId && (ACTIONABLE.has(role) || properties.get('focusable') === true));
    if (hasRef) line += ` [ref=e${node.backendDOMNodeId}]`;
    push(line);
    for (const child of children) walk(child, depth + 1, name, inRef || hasRef);
  };

  const root = nodes.find((node) => !node.parentId) ?? nodes[0];
  walk(root, 0, '');
  if (truncated) lines.push('… (snapshot truncated: the page is very long. Scroll or navigate to narrow it down.)');
  return lines.join('\n') || '(no readable content)';
}
