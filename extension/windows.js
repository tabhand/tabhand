// What the extension does differently on Windows, in one place. background.js calls these only
// when Chrome says it runs on Windows (isWindows); everywhere else its original code runs.
//
// Chrome on Windows, in a background tab (found with Chrome 156):
// - can sit on a screenshot until it's asked again;
// - ignores turns of the mouse wheel after the first.

export const isWindows = chrome.runtime.getPlatformInfo().then(({ os }) => os === 'win');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A screenshot of the tab, asking again while no answer has come and keeping the earlier asks
 * open: whichever answers first is the screenshot. A second ask nearly always does.
 * @param {(tabId: number, method: string, params?: object) => Promise<any>} send background.js's send
 */
export async function captureScreenshot(send, tabId, params) {
  let answer = null;
  let error = null;
  let open = 0;
  const ask = () => {
    open++;
    send(tabId, 'Page.captureScreenshot', params)
      .then((value) => (answer ??= value), (failure) => (error ??= failure))
      .finally(() => open--);
  };
  const started = Date.now();
  for (let asks = 0; !answer && Date.now() - started < 60_000; ) {
    if (asks < 8) {
      ask();
      asks++;
    }
    for (const until = Date.now() + (asks === 1 ? 400 : 1500); !answer && Date.now() < until; await sleep(25)) {
      if (error && open === 0) throw error;
    }
  }
  if (!answer) throw error ?? new Error('Chrome did not take the screenshot. Try again.');
  return answer;
}

/**
 * Runs in the page. With dx and dy 0: where the boxes that scroll under (x, y), and the page, are
 * scrolled to, as text. Otherwise: scrolls the nearest of those boxes that can go that way (or else
 * the page) by dx, dy. It looks through everything at the point, since a dragged item may cover it.
 */
const SCROLL_AT = `(x, y, dx, dy) => {
  const page = document.scrollingElement || document.documentElement;
  const vertical = Boolean(dy) || !dx;
  const scrolls = (el, down) => {
    if (el === page) return down ? el.scrollHeight > el.clientHeight : el.scrollWidth > el.clientWidth;
    const style = getComputedStyle(el);
    const overflow = down ? style.overflowY : style.overflowX;
    return /^(auto|scroll|overlay)$/.test(overflow) && (down ? el.scrollHeight > el.clientHeight : el.scrollWidth > el.clientWidth);
  };
  const boxes = [];
  for (const hit of document.elementsFromPoint(x, y)) {
    for (let el = hit; el && el !== page && el !== document.body; el = el.parentElement) {
      if (!boxes.includes(el) && (scrolls(el, true) || scrolls(el, false))) boxes.push(el);
    }
  }
  boxes.push(page);
  if (!dx && !dy) return boxes.map((box) => Math.round(box.scrollTop) + ':' + Math.round(box.scrollLeft)).join(',');
  const canGo = (el) =>
    scrolls(el, vertical) &&
    (vertical
      ? dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1
      : dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  const target = boxes.find(canGo) || page;
  target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return true;
}`;

/**
 * Turns the mouse wheel at a point, as a hand would, so pages that listen for the wheel see it,
 * waiting at most a second for Chrome. When nothing scrolled, scrolls what's under the point with
 * script instead (see SCROLL_AT).
 * @param {(tabId: number, method: string, params?: object) => Promise<any>} send background.js's send
 */
export async function turnWheel(send, tabId, { x, y }, deltaX, deltaY, { extra = {}, settleMs = 250 } = {}) {
  const position = () =>
    send(tabId, 'Runtime.evaluate', { expression: `(${SCROLL_AT})(${x}, ${y}, 0, 0)`, returnByValue: true }).then(
      (reply) => reply.result?.value ?? null,
      () => null,
    );
  const before = await position();
  await Promise.race([send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, ...extra }).catch(() => {}), sleep(1000)]);
  if (before === null) return;
  await sleep(settleMs);
  if ((await position()) === before) {
    await send(tabId, 'Runtime.evaluate', { expression: `(${SCROLL_AT})(${x}, ${y}, ${deltaX}, ${deltaY})`, returnByValue: true }).catch(() => {});
  }
}
