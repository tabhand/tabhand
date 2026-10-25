// Hover and drag, in a background tab: controls that only appear while the pointer is over
// something (Product Hunt's delete button on a gallery image), and lists reordered by dragging,
// both the browser's own HTML5 drag and drop and the kind built from mouse events (the way
// SortableJS does it in fallback mode).
//
//   node test/drag-hover.mjs

import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BridgeClient } from '../src/bridge-client.mjs';
import { launchTestBrowser, sleep } from './harness.mjs';

const page = `<!doctype html><title>Hover and drag</title>
<style>
  body { font: 16px sans-serif; margin: 0; padding: 20px }
  .card { display: inline-block; width: 220px; height: 70px; margin: 8px; padding: 10px; border: 1px solid #aaa; vertical-align: top }
  .card .remove { display: none }
  #css-card:hover .remove { display: inline-block }
  #js-card { cursor: pointer }
  ul { list-style: none; margin: 8px; padding: 0; width: 240px; display: inline-block; vertical-align: top }
  li { height: 36px; line-height: 36px; margin: 4px 0; padding: 0 10px; border: 1px solid #888; background: #fff; user-select: none }
  #mouse-list li { cursor: pointer }
  #scroll-box { display: inline-block; vertical-align: top; width: 200px; height: 150px; overflow: auto; margin: 8px; border: 1px solid #888 }
  #scroll-box ul, #edge-box ul, #far-list { margin: 0; width: auto; display: block }
  #edge-box { display: inline-block; vertical-align: top; width: 200px; height: 150px; overflow: auto; margin: 8px; border: 1px solid #888 }
  #ghost { position: fixed; width: 30px; height: 30px; margin: -15px 0 0 -15px; background: #fa0; opacity: .8; z-index: 9 }
</style>
<body>
  <div class="card" id="css-card"><span>Picture shown by CSS</span> <button class="remove" id="remove-css">Remove CSS picture</button></div>
  <div class="card" id="js-card"><span>Picture shown by script</span></div>
  <br>
  <ul id="native-list" class="native">
    <li draggable="true">Alpha</li><li draggable="true">Bravo</li><li draggable="true">Charlie</li><li draggable="true">Delta</li>
  </ul>
  <ul id="native-list-b" class="native">
    <li draggable="true">Zulu</li><li draggable="true">Alpha</li>
  </ul>
  <ul id="mouse-list">
    <li>One</li><li>Two</li><li>Three</li><li>Four</li>
  </ul>
  <ul id="delay-list">
    <li>Press1</li><li>Press2</li><li>Press3</li><li>Press4</li>
  </ul>
  <div id="scroll-box"><ul id="scroll-list"></ul></div>
  <div id="edge-box"><ul id="edge-list"></ul></div>
  <div class="card" id="slow-card"><span>Picture shown after a delay</span></div>
  <ul id="far-list"></ul>
  <script>
    const report = (key, value) => fetch('/report?key=' + key + '&value=' + encodeURIComponent(value));
    const order = (list) => [...list.children].map((item) => item.textContent).join(',');

    // A button the script adds while the pointer is over the card, and takes away when it leaves.
    const card = document.getElementById('js-card');
    card.addEventListener('mouseenter', () => {
      const button = document.createElement('button');
      button.id = 'remove-js';
      button.textContent = 'Remove script picture';
      button.addEventListener('click', () => report('removed', 'script'));
      card.append(button);
    });
    card.addEventListener('mouseleave', () => document.getElementById('remove-js')?.remove());
    document.getElementById('remove-css').addEventListener('click', () => report('removed', 'css'));

    // A button that shows up a while after the pointer arrives, as a hover card does once the page
    // has asked a server for what to put in it.
    const slow = document.getElementById('slow-card');
    let slowTimer = null;
    slow.addEventListener('mouseenter', () => {
      slowTimer = setTimeout(() => {
        const button = document.createElement('button');
        button.id = 'remove-slow';
        button.textContent = 'Remove delayed picture';
        button.addEventListener('click', () => report('removed', 'delayed'));
        slow.append(button);
      }, 800);
    });
    slow.addEventListener('mouseleave', () => { clearTimeout(slowTimer); document.getElementById('remove-slow')?.remove(); });

    // The browser's own drag and drop: draggable items with dragstart, dragover and drop handlers.
    const native = document.getElementById('native-list');
    const nativeB = document.getElementById('native-list-b');
    const seen = [];
    let dragged = null;
    for (const list of document.querySelectorAll('.native')) {
      list.addEventListener('dragstart', (event) => {
        dragged = event.target.closest('li');
        event.dataTransfer.setData('text/plain', dragged.textContent);
        event.dataTransfer.effectAllowed = 'move';
        seen.push('dragstart');
      });
      list.addEventListener('dragover', (event) => event.preventDefault());
      list.addEventListener('drop', (event) => {
        event.preventDefault();
        const target = event.target.closest('li');
        if (!dragged || !target || target === dragged) return;
        if (dragged.parentNode !== target.parentNode) {
          target.parentNode.insertBefore(dragged, target);
          report('cross', order(native) + ' | ' + order(nativeB));
          return;
        }
        const items = [...list.children];
        target.parentNode.insertBefore(dragged, items.indexOf(dragged) < items.indexOf(target) ? target.nextSibling : target);
        seen.push('drop');
        report('native', order(native));
      });
      list.addEventListener('dragend', () => { seen.push('dragend'); report('native-events', seen.join(',')); });
    }

    // A list moved with mouse events only: press, move with the button held, let go.
    const mouse = document.getElementById('mouse-list');
    let held = null;
    mouse.addEventListener('mousedown', (event) => { if (event.button === 0) held = event.target.closest('li'); });
    document.addEventListener('mousemove', (event) => {
      if (!held || !(event.buttons & 1)) return;
      const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('#mouse-list li');
      if (!over || over === held) return;
      const items = [...mouse.children];
      over.parentNode.insertBefore(held, items.indexOf(held) < items.indexOf(over) ? over.nextSibling : over);
    });
    document.addEventListener('mouseup', () => {
      if (!held) return;
      held = null;
      report('mouse', order(mouse));
    });

    // Lists whose rows are filled in by script: one below the fold, one inside a box that scrolls.
    for (let i = 1; i <= 40; i++) document.getElementById('far-list').append(Object.assign(document.createElement('li'), { textContent: 'Far ' + i }));
    for (let i = 1; i <= 20; i++) document.getElementById('scroll-list').append(Object.assign(document.createElement('li'), { textContent: 'Box ' + i }));

    // Mouse-event lists that never scroll by themselves: the page only moves if the wheel does.
    for (const [id, key] of [['far-list', 'far'], ['scroll-list', 'box']]) {
      const list = document.getElementById(id);
      let grabbed = null;
      list.addEventListener('mousedown', (event) => { if (event.button === 0) grabbed = event.target.closest('li'); });
      document.addEventListener('mousemove', (event) => {
        if (!grabbed || !(event.buttons & 1)) return;
        const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('#' + id + ' li');
        if (!over || over === grabbed) return;
        const items = [...list.children];
        over.parentNode.insertBefore(grabbed, items.indexOf(grabbed) < items.indexOf(over) ? over.nextSibling : over);
      });
      document.addEventListener('mouseup', () => {
        if (!grabbed) return;
        grabbed = null;
        report(key, order(list));
      });
    }

    // A list that scrolls only by itself, the way dnd-kit's does: once an item is lifted a stand-in
    // follows the pointer (so the wheel, which lands on it, never reaches the box), and the box
    // scrolls while the pointer is in its top or bottom 40px.
    const edgeBox = document.getElementById('edge-box');
    const edge = document.getElementById('edge-list');
    for (let i = 1; i <= 40; i++) edge.append(Object.assign(document.createElement('li'), { textContent: 'Edge ' + i }));
    let lifted = null;
    let ghost = null;
    let pointer = { x: 0, y: 0 };
    edge.addEventListener('mousedown', (event) => { if (event.button === 0) lifted = event.target.closest('li'); });
    document.addEventListener('mousemove', (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (!lifted || !(event.buttons & 1)) return;
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.id = 'ghost';
        ghost.addEventListener('wheel', (wheel) => wheel.preventDefault(), { passive: false });
        document.body.append(ghost);
      }
      ghost.style.left = event.clientX + 'px';
      ghost.style.top = event.clientY + 'px';
    });
    setInterval(() => {
      if (!lifted || !ghost) return;
      const box = edgeBox.getBoundingClientRect();
      if (pointer.x < box.left || pointer.x > box.right) return;
      if (pointer.y > box.bottom - 40) edgeBox.scrollTop += Math.min(1, (pointer.y - (box.bottom - 40)) / 40) * 12;
      if (pointer.y < box.top + 40) edgeBox.scrollTop -= Math.min(1, (box.top + 40 - pointer.y) / 40) * 12;
    }, 16);
    document.addEventListener('mouseup', () => {
      if (!lifted) return;
      // The item goes where it is let go.
      const over = document.elementsFromPoint(pointer.x, pointer.y).find((element) => element.matches('#edge-list li'));
      if (over && over !== lifted) over.after(lifted);
      lifted = null;
      ghost?.remove();
      ghost = null;
      report('edge', order(edge));
    });

    // A list that needs the button held still for a moment before it will drag (a press delay), and
    // that moves its rows a moment after the button is let go (state that is updated later).
    const delay = document.getElementById('delay-list');
    let pressed = null;
    delay.addEventListener('mousedown', (event) => {
      const row = event.target.closest('li');
      if (event.button !== 0 || !row) return;
      pressed = { row, x: event.clientX, y: event.clientY, armed: false, over: row };
      setTimeout(() => { if (pressed?.row === row) pressed.armed = true; }, 250);
    });
    document.addEventListener('mousemove', (event) => {
      if (!pressed || !(event.buttons & 1)) return;
      if (!pressed.armed) {
        // Moving before the delay is over cancels the drag.
        if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 5) pressed = null;
        return;
      }
      pressed.over = document.elementFromPoint(event.clientX, event.clientY)?.closest('#delay-list li') ?? pressed.over;
    });
    document.addEventListener('mouseup', () => {
      if (!pressed) return;
      const { row, over, armed } = pressed;
      pressed = null;
      if (!armed || over === row) return;
      setTimeout(() => {
        const items = [...delay.children];
        over.parentNode.insertBefore(row, items.indexOf(row) < items.indexOf(over) ? over.nextSibling : over);
        report('delay', order(delay));
      }, 200);
    });
  </script>
</body>`;

const reported = {};
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/report') {
    reported[url.searchParams.get('key')] = url.searchParams.get('value');
    response.end();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(page);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const browser = await launchTestBrowser();
const bridge = new BridgeClient({ sessionId: crypto.randomUUID(), label: 'Claude', theme: 'claude' });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let mcp = null;
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};
/** What the page told the server, once it has (the page reports a moment after the event). */
const heard = async (key, wanted) => {
  for (let i = 0; i < 30 && reported[key] !== wanted; i++) await sleep(100);
  return reported[key];
};
const refOf = (snapshot, pattern) => pattern.exec(snapshot)?.[1];
const refs = (snapshot, pattern) => [...snapshot.matchAll(pattern)].map((match) => match[1]);

try {
  if (!browser.connected) throw new Error('The test browser did not connect.');
  const { tabId } = await bridge.request('open_tab', { url: `http://127.0.0.1:${server.address().port}/` });
  let { snapshot } = await bridge.request('snapshot', { tabId });

  check('hover-only buttons are not in the snapshot yet', !/Remove (CSS|script) picture/.test(snapshot), 'before hovering');

  // A button the stylesheet shows on :hover.
  let hovered = await bridge.request('hover', { tabId, text: 'Picture shown by CSS' });
  let ref = refOf(hovered.snapshot ?? '', /button "Remove CSS picture" \[ref=(e\d+)\]/);
  check('hovering by text shows a CSS :hover button, with a ref, in the snapshot it returns', Boolean(ref), `ref: ${ref ?? 'none'}`);
  if (ref) await bridge.request('click', { tabId, ref });
  check('that button can then be clicked', (await heard('removed', 'css')) === 'css', `page heard: ${reported.removed}`);

  // A button a mouseenter handler adds; the card is found by its ref this time (it is a clickable).
  ({ snapshot } = await bridge.request('snapshot', { tabId }));
  const card = refOf(snapshot, /clickable "Picture shown by script" \[ref=(e\d+)\]/);
  hovered = await bridge.request('hover', { tabId, ref: card });
  ref = refOf(hovered.snapshot ?? '', /button "Remove script picture" \[ref=(e\d+)\]/);
  check('hovering by ref shows a button a mouseenter handler adds', Boolean(card) && Boolean(ref), `card: ${card ?? 'none'}, button: ${ref ?? 'none'}`);
  if (ref) await bridge.request('click', { tabId, ref });
  check('that button can then be clicked', (await heard('removed', 'script')) === 'script', `page heard: ${reported.removed}`);

  // A card that only brings up its button a moment after the pointer arrives: the snapshot a hover
  // answers with has to wait for it.
  hovered = await bridge.request('hover', { tabId, text: 'Picture shown after a delay' });
  ref = refOf(hovered.snapshot ?? '', /button "Remove delayed picture" \[ref=(e\d+)\]/);
  check('hovering waits for a button that shows up a moment after the pointer arrives', Boolean(ref), `ref: ${ref ?? 'none'}`);
  if (ref) await bridge.request('click', { tabId, ref });
  check('that button can then be clicked', (await heard('removed', 'delayed')) === 'delayed', `page heard: ${reported.removed}`);

  const nothing = await bridge.request('hover', { tabId }).then(
    () => 'hovered',
    (error) => error.message,
  );
  check('hovering without a ref or text is an error', /ref/i.test(nothing), nothing);

  // The browser's own drag and drop, by the words on the items.
  let dragged = await bridge.request('drag', { tabId, fromText: 'Alpha', toText: 'Charlie' });
  check('dragging down a native HTML5 list reorders it', (await heard('native', 'Bravo,Charlie,Alpha,Delta')) === 'Bravo,Charlie,Alpha,Delta', `page order: ${reported.native}`);
  check('the page gets dragstart, drop and dragend, as from a real drag', (await heard('native-events', 'dragstart,drop,dragend')) === 'dragstart,drop,dragend', `page events: ${reported['native-events']}`);
  check('the result says what was dragged onto what', /Alpha/.test(dragged.dragged ?? '') && /Charlie/.test(dragged.dragged ?? ''), `said: ${dragged.dragged}`);
  check('that drag was taken over from Chrome and played into the page as drag events', dragged.nativeDrag === true, `nativeDrag: ${dragged.nativeDrag}`);
  reported.native = undefined;
  await bridge.request('drag', { tabId, fromText: 'Delta', toText: 'Bravo' });
  check('dragging up a native HTML5 list reorders it too', (await heard('native', 'Delta,Bravo,Charlie,Alpha')) === 'Delta,Bravo,Charlie,Alpha', `page order: ${reported.native}`);

  // Draggable items get refs in the snapshot, so two items with the same words can be told apart,
  // even when they are in different lists.
  ({ snapshot } = await bridge.request('snapshot', { tabId }));
  const alphas = refs(snapshot, /draggable "Alpha" \[ref=(e\d+)\]/g);
  check('draggable items are in the snapshot with refs', alphas.length === 2, `refs for "Alpha": ${alphas.join(', ') || 'none'}`);
  if (alphas.length === 2) {
    const delta = refOf(snapshot, /draggable "Delta" \[ref=(e\d+)\]/);
    await bridge.request('drag', { tabId, fromRef: alphas[1], toRef: delta });
    // Delta,Bravo,Charlie,Alpha is how the first list stands now; the second Alpha moves in before Delta.
    check('dragging an item from one list into another, picked by ref, moves that item', (await heard('cross', 'Alpha,Delta,Bravo,Charlie,Alpha | Zulu')) === 'Alpha,Delta,Bravo,Charlie,Alpha | Zulu', `page order: ${reported.cross}`);
  }

  // A list moved by mouse events alone, by the refs the snapshot gives its items.
  ({ snapshot } = await bridge.request('snapshot', { tabId }));
  const item = (name) => refOf(snapshot, new RegExp(`clickable "${name}" \\[ref=(e\\d+)\\]`));
  dragged = await bridge.request('drag', { tabId, fromRef: item('One'), toRef: item('Three') });
  check('dragging down a mouse-event list reorders it', (await heard('mouse', 'Two,Three,One,Four')) === 'Two,Three,One,Four', `page order: ${reported.mouse}`);
  check('a list with no native drag is moved with plain mouse events', dragged.nativeDrag === false, `nativeDrag: ${dragged.nativeDrag}`);
  reported.mouse = undefined;
  await bridge.request('drag', { tabId, fromRef: item('Four'), toRef: item('Two') });
  check('dragging up a mouse-event list reorders it too', (await heard('mouse', 'Four,Two,Three,One')) === 'Four,Two,Three,One', `page order: ${reported.mouse}`);

  // A list that wants the button held still for a moment first, then moves its rows a moment after
  // the button is let go.
  dragged = await bridge.request('drag', { tabId, fromText: 'Press1', toText: 'Press3' });
  check('dragging a list that needs a press delay reorders it', (await heard('delay', 'Press2,Press3,Press1,Press4')) === 'Press2,Press3,Press1,Press4', `page order: ${reported.delay}`);
  check('and the result reports the move even though the page made it a moment after letting go', /moved from position 1 of 4 to 3 of 4/.test(dragged.dragged ?? ''), `said: ${dragged.dragged}`);

  // Targets that start out of sight: the page has to be scrolled while the item is held.
  const rows = (name, count) => Array.from({ length: count }, (_, i) => `${name} ${i + 1}`);
  const lastToEnd = (name, count) => [...rows(name, count).slice(1), `${name} 1`].join(',');
  await bridge.request('drag', { tabId, fromText: 'Box 1', toText: 'Box 20' });
  check('dragging inside a box that scrolls, onto a row not yet in sight, gets there', (await heard('box', lastToEnd('Box', 20))) === lastToEnd('Box', 20), `last rows: ${reported.box?.split(',').slice(-3).join(',')}`);
  await bridge.request('drag', { tabId, fromText: 'Edge 1', toText: 'Edge 30' });
  const edgeOrder = [...rows('Edge', 30).slice(1), 'Edge 1', ...rows('Edge', 40).slice(30)].join(',');
  check('dragging a list that scrolls only when the item is held at its edge, onto a row not yet in sight, gets there', (await heard('edge', edgeOrder)) === edgeOrder, `rows 28 to 32: ${reported.edge?.split(',').slice(27, 32).join(',')}`);
  await bridge.request('drag', { tabId, fromText: 'Far 1', toText: 'Far 40' });
  check('dragging down a page, onto a row far below the fold, gets there', (await heard('far', lastToEnd('Far', 40))) === lastToEnd('Far', 40), `last rows: ${reported.far?.split(',').slice(-3).join(',')}`);

  const { windows } = await bridge.request('diagnostics', { tabId });
  check('all of it happened in a background tab', windows.every((window) => window.activeTab !== 'this-session'), `active tabs: ${windows.map((window) => window.activeTab).join(', ')}`);

  // The same through an agent's own tools, as they are described to it.
  mcp = new Client({ name: 'tabhand-drag-hover', version: '0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin/tabhand.mjs'), 'mcp', '--label', 'Claude'], env: { ...process.env } }));
  const tools = (await mcp.listTools()).tools.map((tool) => tool.name);
  check('browser_hover and browser_drag are offered to agents', tools.includes('browser_hover') && tools.includes('browser_drag'), tools.filter((name) => /hover|drag/.test(name)).join(', '));
  const use = async (name, args) => {
    const result = await mcp.callTool({ name, arguments: args });
    return { error: result.isError, text: result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n') };
  };
  const opened = await use('browser_open_tab', { url: `http://127.0.0.1:${server.address().port}/` });
  const agentTab = Number(/^Tab (\d+):/m.exec(opened.text)?.[1]);
  const looked = await use('browser_hover', { tabId: agentTab, text: 'Picture shown by CSS' });
  check('browser_hover answers with the snapshot, hover-only button included', !looked.error && /button "Remove CSS picture" \[ref=e\d+\]/.test(looked.text), looked.text.split('\n')[0]);
  reported.native = undefined;
  const moved = await use('browser_drag', { tabId: agentTab, fromText: 'Bravo', toText: 'Delta' });
  check('browser_drag says what it did', !moved.error && /^Dragged "Bravo" onto "Delta"\./.test(moved.text), moved.text.split('\n')[0]);
  check('and the list is reordered', (await heard('native', 'Alpha,Charlie,Delta,Bravo')) === 'Alpha,Charlie,Delta,Bravo', `page order: ${reported.native}`);
  const nowhere = await use('browser_drag', { tabId: agentTab, fromText: 'Alpha' });
  check('browser_drag without a place to drop is an error', nowhere.error === true && /drop/.test(nowhere.text), nowhere.text);
} catch (error) {
  check('test run', false, error.message);
} finally {
  await mcp?.close().catch(() => {});
  bridge.close();
  server.close();
  await browser.close();
  process.exit(results.every(Boolean) ? 0 : 1);
}
