// Turns Chrome's accessibility tree into a compact outline an agent can read. Elements the agent
// can act on get a ref (e123) that browser_click and browser_type accept. A ref is the element's
// DOM backend node id, so it stays valid until the page navigates or the element is removed.

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

export function renderSnapshot(nodes) {
  if (!nodes?.length) return '(empty page)';
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
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

  const walk = (node, depth, parentName) => {
    if (!node || truncated) return;
    const role = node.role?.value ?? '';
    const name = clean(node.name?.value);
    const children = (node.childIds ?? []).map((id) => byId.get(id));
    const pad = '  '.repeat(depth);

    if (node.ignored || role === 'RootWebArea' || (TRANSPARENT.has(role) && !name)) {
      for (const child of children) walk(child, depth, parentName);
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
    if (node.backendDOMNodeId && (ACTIONABLE.has(role) || properties.get('focusable') === true)) {
      line += ` [ref=e${node.backendDOMNodeId}]`;
    }
    push(line);
    for (const child of children) walk(child, depth + 1, name);
  };

  const root = nodes.find((node) => !node.parentId) ?? nodes[0];
  walk(root, 0, '');
  if (truncated) lines.push('… (snapshot truncated: the page is very long. Scroll or navigate to narrow it down.)');
  return lines.join('\n') || '(no readable content)';
}
