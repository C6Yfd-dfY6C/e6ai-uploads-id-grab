// ==UserScript==
// @name         e6AI User Post ID Grabber
// @namespace    https://e6ai.net/
// @version      1.0
// @description  Fetch all post IDs uploaded by an e6AI user (by username or numeric user ID) via the API, paginating past the 320-post limit. Copy or download the results.
// @author       dfY6C using Qwen
// @match        https://e6ai.net/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const LIMIT = 320;          // hard server limit per request
  const DELAY_MS = 1050;      // stay under the ~1 req/s sustained rate limit
  const CLIENT = 'e6ai-user-post-grabber/1.0 (userscript)';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** GET a same-origin API path as JSON, retrying on throttle/rate-limit responses. */
  async function apiGet(path, token) {
    const url = path + (path.includes('?') ? '&' : '?') + '_client=' + encodeURIComponent(CLIENT);
    let lastErr;
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (token.cancelled) throw new Error('cancelled');
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (res.status === 503 || res.status === 421) {
          lastErr = new Error(`HTTP ${res.status} (throttled)`);
          await sleep(2000 * attempt); // back off, then retry
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
        return await res.json();
      } catch (e) {
        if (token.cancelled) throw e;
        lastErr = e;
        await sleep(1500 * attempt);
      }
    }
    throw lastErr || new Error('request failed');
  }

  /** Turn a username or numeric user ID into the tag query to search with. */
  async function resolveUser(input, token) {
    const t = input.trim();
    // Tags can't contain spaces - usernames with spaces are stored in tags
    // with underscores. Treat spaces and underscores as equivalent so that
    // "df y6c" and "df_y6c" both produce the same search.
    const toTag = (name) => 'user:' + name.replace(/[\s_]+/g, '_');
    if (/^\d+$/.test(t)) {
      try {
        const user = await apiGet('/users/' + encodeURIComponent(t) + '.json', token);
        return { display: `${user.name} (ID ${t})`, tag: toTag(user.name) };
      } catch (e) {
        // Name lookup failed (bad ID, etc.) - fall back to the ID-based metatag.
        return { display: `ID ${t} (name lookup failed, using user:!${t})`, tag: 'user:!' + t };
      }
    }
    return { display: t, tag: toTag(t) };
  }

  /**
   * Fetch every post ID matching a tag query.
   * Uses the docs-recommended page=b<lowest_id> iteration (forces order:id_desc),
   * which is stable even when new posts are created between requests.
   */
  async function fetchAllPostIds(tagQuery, includeDeleted, token, onProgress) {
    const ids = new Set();
    let pageParam = '';
    let round = 0;
    for (;;) {
      if (token.cancelled) break;
      round++;
      // status:any includes deleted posts in the results.
      const query = includeDeleted ? tagQuery + ' status:any' : tagQuery;
      let path = `/posts.json?tags=${encodeURIComponent(query)}&limit=${LIMIT}`;
      if (pageParam) path += `&page=${pageParam}`;
      const data = await apiGet(path, token);
      // The docs say this returns a bare JSON array, but the live API wraps it:
      // { "posts": [ ... ] }. Handle both shapes.
      const posts = Array.isArray(data) ? data
        : (data && Array.isArray(data.posts)) ? data.posts
        : [];
      onProgress(round, posts.length, ids.size);
      for (const p of posts) ids.add(p.id);
      if (posts.length < LIMIT) break; // final page
      const minId = Math.min(...posts.map((p) => p.id));
      pageParam = 'b' + minId;         // next batch: everything older than minId
      await sleep(DELAY_MS);
    }
    return [...ids].sort((a, b) => a - b);
  }

  /* ------------------------------ UI ------------------------------ */

  const host = document.createElement('div');
  host.id = 'e6ai-grabber-host';
  const root = host.attachShadow({ mode: 'closed' });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, sans-serif; }
      #panel {
        position: fixed; z-index: 2147483645;
        width: 380px; max-height: 90vh; overflow-y: auto;
        background: #1e1f24; color: #e6e6e6; border: 1px solid #444;
        border-radius: 8px; padding: 12px; font-size: 13px;
        box-shadow: 0 4px 16px rgba(0,0,0,.5);
      }
      h1 { font-size: 14px; margin: 0 0 8px; display: flex; justify-content: space-between; align-items: center; }
      button {
        background: #3a6df0; color: #fff; border: 0; border-radius: 4px;
        padding: 6px 10px; font-size: 12px; cursor: pointer;
      }
      button:hover { background: #4d7cf5; }
      button:disabled { opacity: .5; cursor: default; }
      button.secondary { background: #444; }
      input[type=text] {
        width: 100%; padding: 6px 8px; border-radius: 4px;
        border: 1px solid #555; background: #12131a; color: #eee; font-size: 13px;
      }
      #status { min-height: 18px; margin: 6px 0; color: #9fd0ff; white-space: pre-wrap; }
      #results { margin-top: 8px; }
      .userblock { margin-bottom: 10px; }
      .userblock h2 { font-size: 12px; margin: 0 0 4px; color: #ffd479; }
      pre {
        background: #12131a; border: 1px solid #333; border-radius: 4px;
        padding: 6px; font-size: 11px; max-height: 140px; overflow-y: auto;
        white-space: pre-wrap; word-break: break-all; margin: 0;
      }
      .row { display: flex; gap: 6px; margin-top: 8px; }
      .checkrow {
        display: flex; align-items: center; gap: 6px; margin-top: 8px;
        font-size: 12px; color: #ccc; cursor: pointer;
      }
      .checkrow input { accent-color: #3a6df0; cursor: pointer; }
      .infotext {
        margin-top: 10px; font-size: 11px; line-height: 1.45; color: #bbb;
        white-space: pre-wrap; text-align: left;
      }
      .infotext b { color: #ff9d9d; }
      .infotext a { color: #7fb0ff; text-decoration: underline; }
      #closebtn { background: none; color: #999; padding: 0 4px; font-size: 15px; }
      .step { margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid #3a3b40; }
      .steplabel { font-size: 12px; font-weight: 600; color: #ffd479; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
      .help {
        display: inline-flex; align-items: center; justify-content: center;
        width: 15px; height: 15px; border-radius: 50%; background: #4a4b52; color: #fff;
        font-size: 10px; font-weight: 700; cursor: help; flex-shrink: 0;
      }
      h1 { cursor: move; user-select: none; touch-action: none; }
    </style>
    <div id="panel">
      <h1>e6AI Post ID Grabber <button id="closebtn" title="Hide">✕</button></h1>
      <div class="step">
        <div class="steplabel">Step 1. Make a New Set
          <span class="help" id="helpicon">?</span>
        </div>
        <button id="newsetbtn">New Set</button>
      </div>
      <div class="step">
        <div class="steplabel">Step 2. Fetch your "Uploads" post IDs</div>
        <input type="text" id="input" placeholder="Username or user ID, e.g. Jelloponies or 11464" />
        <label class="checkrow"><input type="checkbox" id="deletedchk" checked /> Include deleted uploads</label>
        <div class="row">
          <button id="fetchbtn">Fetch</button>
          <button id="cancelbtn" class="secondary" disabled>Cancel</button>
        </div>
        <div id="status"></div>
      </div>
      <div class="step" style="border-bottom: none; padding-bottom: 0">
        <div class="steplabel">Step 3. Copy Post IDs to the Set and Export User Data</div>
        <div id="results"></div>
        <div class="row" id="actionrow" style="display:none">
          <button id="copy">Copy</button>
          <button id="download" class="secondary">Download .txt</button>
        </div>
        <div class="infotext">Copy these post IDs and paste them in the Post IDs textbox after pressing "Edit Posts" in your new set. The "Edit Posts" button is found at the top of the page. After pasting, press update, and your posts will now be in the new set. If you get lost and can't find your new set, click on your profile picture on the top right and then press Sets. This window will remember the fetched post IDs when browsing different pages on e6AI.

Finally, you should download the .txt file above with the post IDs and keep it as a backup, but more importantly, <a href="https://e6ai.net/users/settings?find=export" target="_blank" rel="noopener">go to your user settings and export your user data</a> which will now contain the data for your new set and of course keep this file stored safely. You will use this on floofgens to re-import your data when the team launches that site. <b>You must export your user data before e6AI is shut down!</b></div>
      </div>
    </div>`;

  const $ = (id) => root.getElementById(id);
  const input = $('input'), fetchBtn = $('fetchbtn'), cancelBtn = $('cancelbtn');
  const statusEl = $('status'), resultsEl = $('results'), actionRow = $('actionrow');

  // Floating button: collapsed by default, draggable, position remembered.
  const POS_KEY = 'e6ai-grabber-btn-pos';
  function loadPos(key) {
    try { return JSON.parse(localStorage.getItem(key || POS_KEY)); } catch (e) { return null; }
  }

  const panel = $('panel');
  const toggle = document.createElement('button');
  toggle.textContent = 'Post IDs for e6AI Uploads';
  Object.assign(toggle.style, {
    position: 'fixed', zIndex: '2147483646',
    background: '#3a6df0', color: '#fff', border: 'none', borderRadius: '5px',
    padding: '9px 14px', fontSize: '13px', cursor: 'pointer', userSelect: 'none', touchAction: 'none',
  });

  function placeButton(x, y) {
    const r = toggle.getBoundingClientRect();
    x = Math.max(0, Math.min(x, window.innerWidth - r.width));
    y = Math.max(0, Math.min(y, window.innerHeight - r.height));
    toggle.style.left = x + 'px';
    toggle.style.top = y + 'px';
  }

  const PANEL_POS_KEY = 'e6ai-grabber-panel-pos';

  function placePanel(x, y) {
    x = Math.max(0, Math.min(x, window.innerWidth - panel.offsetWidth));
    y = Math.max(0, Math.min(y, window.innerHeight - panel.offsetHeight));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  }

  // Open the panel: at its last dragged position if remembered,
  // otherwise anchored next to the button (above it, or below if no room).
  function openPanel() {
    host.style.display = '';
    toggle.style.display = 'none';
    const saved = loadPos(PANEL_POS_KEY);
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      placePanel(saved.x, saved.y);
      return;
    }
    const br = toggle.getBoundingClientRect();
    let left = Math.max(8, Math.min(br.left, window.innerWidth - panel.offsetWidth - 8));
    let top = br.top - panel.offsetHeight - 8;
    if (top < 8) top = br.bottom + 8;
    placePanel(left, top);
  }

  // Drag the expanded window by its header; position is remembered.
  let pdrag = null;
  const header = root.getElementById('panel').querySelector('h1');
  header.addEventListener('pointerdown', (e) => {
    if (e.target.id === 'closebtn') return;
    e.preventDefault();
    const pr = panel.getBoundingClientRect();
    pdrag = { startX: e.clientX, startY: e.clientY, origX: pr.left, origY: pr.top, moved: false };
    header.setPointerCapture(e.pointerId);
  });
  header.addEventListener('pointermove', (e) => {
    if (!pdrag) return;
    const dx = e.clientX - pdrag.startX, dy = e.clientY - pdrag.startY;
    if (!pdrag.moved && Math.hypot(dx, dy) < 4) return;
    pdrag.moved = true;
    placePanel(pdrag.origX + dx, pdrag.origY + dy);
  });
  header.addEventListener('pointerup', () => {
    if (!pdrag) return;
    const moved = pdrag.moved;
    pdrag = null;
    if (moved) {
      const pr = panel.getBoundingClientRect();
      try { localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ x: pr.left, y: pr.top })); } catch (e) {}
    }
  });

  function closePanel() {
    host.style.display = 'none';
    toggle.style.display = '';
  }

  // Click opens the panel; dragging repositions the button and remembers it.
  let drag = null;
  toggle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const br = toggle.getBoundingClientRect();
    drag = { startX: e.clientX, startY: e.clientY, origX: br.left, origY: br.top, moved: false };
    toggle.setPointerCapture(e.pointerId);
  });
  toggle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    placeButton(drag.origX + dx, drag.origY + dy);
  });
  toggle.addEventListener('pointerup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) {
      const br = toggle.getBoundingClientRect();
      try { localStorage.setItem(POS_KEY, JSON.stringify({ x: br.left, y: br.top })); } catch (e) {}
    } else {
      openPanel();
    }
  });

  root.getElementById('closebtn').addEventListener('click', closePanel);

  // Step 1: open the new-set page in a new tab (keeps this UI's state intact).
  $('newsetbtn').addEventListener('click', () => window.open('https://e6ai.net/post_sets/new', '_blank'));

  // Step 1 help tooltip. Rendered in document.body (not inside the panel) so
  // the panel's overflow-y:auto can't clip it.
  const helpText = `It doesn't matter what you put for the Name and Short Name, but if you are unsure, you can use this format:

- Name: [username]'s e6AI Uploads (for example: dfY6C's e6AI Uploads)
- Short Name: [username]_uploads (for example: dfy6c_uploads)

- The set can be either public or private, it does not matter.

Submit/create the set after deciding these three things and then click on "Edit Posts" at the top of the page when your new set is made.`;
  const helpTip = document.createElement('div');
  Object.assign(helpTip.style, {
    position: 'fixed', display: 'none', zIndex: '2147483647', width: '320px', // above panel (2147483645) and toggle (2147483646)
    background: '#12131a', border: '1px solid #555', borderRadius: '4px',
    padding: '8px 10px', color: '#ddd', fontSize: '11px', lineHeight: '1.45',
    whiteSpace: 'pre-wrap', textAlign: 'left', boxSizing: 'border-box',
    boxShadow: '0 4px 12px rgba(0,0,0,.6)', pointerEvents: 'none',
  });
  helpTip.textContent = helpText;
  const helpIcon = $('helpicon');
  function showHelpTip() {
    const r = helpIcon.getBoundingClientRect();
    let left = Math.max(8, Math.min(r.left, window.innerWidth - 320 - 8));
    let top = r.bottom + 6;
    if (top + helpTip.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, r.top - helpTip.offsetHeight - 6); // no room below: open above
    }
    helpTip.style.left = left + 'px';
    helpTip.style.top = top + 'px';
    helpTip.style.display = '';
  }
  function hideHelpTip() { helpTip.style.display = 'none'; }
  helpIcon.addEventListener('mouseenter', showHelpTip);
  helpIcon.addEventListener('mouseleave', hideHelpTip);
  helpIcon.addEventListener('focus', showHelpTip);
  helpIcon.addEventListener('blur', hideHelpTip);
  document.body.appendChild(helpTip);

  // Stop keystrokes made inside our UI from reaching global hotkey handlers
  // registered on document/window by other userscripts. Capture phase on the
  // host boundary fires before any document-level bubble listeners, and since
  // shadow DOM events are retargeted to the host, this covers everything in
  // the panel (inputs included). Outside our UI, hotkeys work normally.
  for (const type of ['keydown', 'keyup']) {
    host.addEventListener(type, (e) => e.stopPropagation(), true);
    toggle.addEventListener(type, (e) => e.stopPropagation(), true);
  }

  host.style.display = 'none'; // collapsed by default; the floating button opens it
  document.body.appendChild(host);
  document.body.appendChild(toggle);

  // First launch: bottom-left corner. Otherwise restore the saved position.
  requestAnimationFrame(() => {
    const saved = loadPos();
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      placeButton(saved.x, saved.y);
    } else {
      const r = toggle.getBoundingClientRect();
      placeButton(12, window.innerHeight - r.height - 12);
    }
  });

  let token = { cancelled: false };
  let allResults = []; // [{display, ids: number[]}]

  // Persist the input and fetched IDs across page navigations.
  const INPUT_KEY = 'e6ai-grabber-input';
  const RESULTS_KEY = 'e6ai-grabber-results';
  function saveInput() {
    try { localStorage.setItem(INPUT_KEY, input.value); } catch (e) {}
  }
  function saveResults() {
    try { localStorage.setItem(RESULTS_KEY, JSON.stringify(allResults)); } catch (e) {}
  }

  // Restore the previous session's input and results on load.
  try {
    const savedInput = localStorage.getItem(INPUT_KEY);
    if (savedInput !== null) input.value = savedInput;
    const savedResults = JSON.parse(localStorage.getItem(RESULTS_KEY));
    if (Array.isArray(savedResults)) {
      allResults = savedResults
        .filter((r) => r && typeof r.display === 'string' && Array.isArray(r.ids))
        .map((r) => ({ display: r.display, ids: r.ids.filter(Number.isFinite) }));
      renderResults();
      if (allResults.length) setStatus(`Restored ${flatIds().length} previously fetched post ID(s).`);
    }
  } catch (e) { /* corrupted storage - start fresh */ }

  function setStatus(msg) { statusEl.textContent = msg; }

  function renderResults() {
    resultsEl.innerHTML = '';
    for (const r of allResults) {
      const block = document.createElement('div');
      block.className = 'userblock';
      const h = document.createElement('h2');
      h.textContent = `${r.display} - ${r.ids.length} posts`;
      const pre = document.createElement('pre');
      pre.textContent = r.ids.join(' ');
      block.appendChild(h);
      block.appendChild(pre);
      resultsEl.appendChild(block);
    }
    actionRow.style.display = allResults.length ? '' : 'none';
  }

  function flatIds() {
    return allResults.flatMap((r) => r.ids);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Copied to clipboard.');
    } catch (e) {
      // Clipboard API can be blocked; fall back to a temporary textarea.
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      setStatus('Copied to clipboard.');
    }
  }

  input.addEventListener('input', saveInput);

  $('copy').addEventListener('click', () => copyText(flatIds().join(' ')));
  $('download').addEventListener('click', () => {
    const blob = new Blob([flatIds().join(' ')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'e6ai-post-ids.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  cancelBtn.addEventListener('click', () => { token.cancelled = true; });

  fetchBtn.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) { setStatus('Enter a username or user ID first.'); return; }

    token = { cancelled: false };
    allResults = [];
    resultsEl.innerHTML = '';
    actionRow.style.display = 'none';
    fetchBtn.disabled = true;
    cancelBtn.disabled = false;

    try {
      setStatus(`${name}: looking up user...`);
      const user = await resolveUser(name, token);
      const ids = await fetchAllPostIds(user.tag, $('deletedchk').checked, token, (round, fetched, total) => {
        setStatus(`${user.display}: page ${round}, got ${fetched} (${total} total)`);
      });
      allResults.push({ display: user.display, ids });
      renderResults();
      saveResults();
    } catch (e) {
      if (!token.cancelled) {
        const block = document.createElement('div');
        block.className = 'userblock';
        block.innerHTML = `<h2>${name}</h2><pre>ERROR: ${e.message || e}</pre>`;
        resultsEl.appendChild(block);
      }
    }

    fetchBtn.disabled = false;
    cancelBtn.disabled = true;
    if (token.cancelled) setStatus('Cancelled.');
    else {
      const total = flatIds().length;
      setStatus(`Done. ${total} post ID${total === 1 ? '' : 's'} found.`);
    }
  });
})();
