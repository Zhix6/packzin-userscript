// ==UserScript==
// @name         Packzin 2.0 — Feed sem repetidos
// @namespace    local.packzin.experience
// @version      1.0.0
// @description  Marca posts abertos e deixa no feed apenas conteúdos ainda não vistos.
// @match        https://packzin.com.br/*
// @match        https://www.packzin.com.br/*
// @updateURL    https://raw.githubusercontent.com/Zhix6/packzin-userscript/main/packzin-feed-seen.meta.js
// @downloadURL  https://raw.githubusercontent.com/Zhix6/packzin-userscript/main/packzin-feed-seen.user.js
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // This addon is intentionally isolated from Packzin 2.0's UI/lifecycle.
  // The shared data-pz-owned marker is the only DOM contract: Packzin 2.0
  // already ignores owned nodes in its MutationObserver.
  const INSTANCE_FLAG = '__packzinFeedSeenV1Loaded';
  if (window.top !== window.self || window[INSTANCE_FLAG]) return;
  window[INSTANCE_FLAG] = true;

  const STORAGE_KEY = 'packzin-feed-seen-v1';
  const PREFS_KEY = 'packzin-feed-seen-preferences-v1';
  const MAX_SEEN = 2000;
  const TOOLBAR_ID = 'pz-feed-seen-toolbar';
  const STYLE_ID = 'pz-feed-seen-style';
  const EVENT_NAME = 'packzin:feed-seen-change';
  const OWNED_SELECTOR = '[data-pz-owned="true"]';
  const FEED_ROUTE = /^(?:\/|\/feed)\/?$/i;
  const POST_ROUTE = /^\/(?:post|publicacao|feed)\/([^/]+)(?:\/|$)/i;
  const POST_CANDIDATES = '.MuiCard-root,article,[data-testid*="post" i],[data-post-id]';

  const root = document.documentElement;
  const seen = new Map();
  const managedNodes = new Set();
  const toggleControls = new Set();
  let preferences = {enabled: true};
  let activeFeedRoot = null;
  let toolbarState = null;
  let panelState = null;
  let scanTimer = 0;
  let scanFrame = 0;
  let scanDirty = true;
  let observer = null;
  let lastSummary = {visible: 0, hidden: 0, total: 0};

  function readJSON(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '');
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function loadPreferences() {
    const saved = readJSON(PREFS_KEY, {});
    preferences.enabled = !saved || saved.enabled !== false;
  }

  function loadSeen() {
    const saved = readJSON(STORAGE_KEY, []);
    const items = Array.isArray(saved) ? saved : Array.isArray(saved?.items) ? saved.items : [];
    for (const item of items) {
      const key = Array.isArray(item) ? item[0] : item?.key;
      const time = Array.isArray(item) ? item[1] : item?.seenAt;
      if (typeof key === 'string' && key) seen.set(key, Number(time) || 0);
    }
    trimSeen();
  }

  function trimSeen() {
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
  }

  function savePreferences() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(preferences));
    } catch {
      // Filtering still works in memory when localStorage is unavailable.
    }
  }

  function saveSeen() {
    trimSeen();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        items: [...seen].map(([key, seenAt]) => ({key, seenAt})),
      }));
    } catch {
      // The current page remains functional; persistence will retry on the
      // next successful mark or after the user clears the browser limitation.
    }
  }

  function announce(action) {
    root.dataset.pzFeedSeenEnabled = String(preferences.enabled);
    root.dataset.pzFeedSeenCount = String(seen.size);
    try {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: Object.freeze({
          action,
          enabled: preferences.enabled,
          seenCount: seen.size,
          version: '1.0.0',
        }),
      }));
    } catch {
      // CustomEvent is available in supported browsers, but never let an
      // integration notification interrupt the feed filter.
    }
  }

  function isFeedRoute() {
    return FEED_ROUTE.test(location.pathname);
  }

  function postKeyFromHref(href) {
    if (!href) return '';
    let url;
    try { url = new URL(href, location.href); } catch { return ''; }
    if (!/^https?:$/i.test(url.protocol) || !/(^|\.)packzin\.com\.br$/i.test(url.hostname)) return '';
    const match = url.pathname.match(POST_ROUTE);
    if (!match) return '';
    let id = match[1];
    try { id = decodeURIComponent(id); } catch {}
    id = String(id || '').trim();
    return id && id.toLowerCase() !== 'feed' ? `post:${id}` : '';
  }

  function currentPostKey() {
    const match = location.pathname.match(POST_ROUTE);
    return match ? postKeyFromHref(location.href) : '';
  }

  function findFeedRoot() {
    const marked = [...document.querySelectorAll('[data-pz-feed]')]
      .find(node => node.querySelector('[aria-label="feed tabs"],#feed-search-input,[name="feed-search-input"]'));
    if (marked) return marked;

    const tabs = document.querySelector('[aria-label="feed tabs"]');
    const search = document.querySelector('#feed-search-input,[name="feed-search-input"]');
    const anchor = search || tabs;
    if (!anchor) return null;

    for (let node = anchor; node && node !== document.body; node = node.parentElement) {
      const hasTabs = !!node.querySelector('[aria-label="feed tabs"]');
      const hasSearch = !!node.querySelector('#feed-search-input,[name="feed-search-input"]');
      const hasPost = !!node.querySelector('a[href*="/post/"],a[href*="/publicacao/"]');
      if (hasTabs && (hasSearch || hasPost)) return node;
    }
    return tabs?.closest('main') || search?.closest('main') || null;
  }

  function findPostLink(node) {
    for (const link of node.querySelectorAll('a[href]')) {
      if (postKeyFromHref(link.getAttribute('href'))) return link;
    }
    return null;
  }

  function entryNode(card, grid) {
    let node = card;
    if (grid) {
      while (node.parentElement && node.parentElement !== grid) node = node.parentElement;
      if (node.parentElement === grid) return node;
    }
    return card.closest('article,[data-testid*="post" i],[data-post-id]') || card;
  }

  function collectEntries(feedRoot) {
    const grid = feedRoot.querySelector('[data-pz-feed-posts-grid]')
      || feedRoot.querySelector('[data-pz-feed-posts]');
    const scope = grid || feedRoot;
    const entries = new Map();
    const cards = [...scope.querySelectorAll(POST_CANDIDATES)];

    for (const card of cards) {
      const link = findPostLink(card);
      const key = postKeyFromHref(link?.getAttribute('href'));
      if (!key) continue;
      const node = entryNode(card, grid);
      if (!entries.has(node)) entries.set(node, {node, link, key});
    }

    // Fallback for a future card component without the current Material UI
    // class. It is intentionally reached only when the fast path is empty.
    if (!entries.size) {
      for (const link of scope.querySelectorAll('a[href]')) {
        const key = postKeyFromHref(link.getAttribute('href'));
        if (!key) continue;
        const node = link.closest(POST_CANDIDATES) || link.closest('.MuiGrid-item,[role="listitem"]') || link;
        if (!entries.has(node)) entries.set(node, {node, link, key});
      }
    }
    return [...entries.values()];
  }

  function clearNodeState(node) {
    delete node.dataset.pzFeedSeenKey;
    delete node.dataset.pzFeedSeenHidden;
    delete node.dataset.pzFeedSeenReason;
  }

  function clearManagedState() {
    for (const node of managedNodes) clearNodeState(node);
    managedNodes.clear();
  }

  function setNodeState(node, key, hidden, reason) {
    node.dataset.pzFeedSeenKey = key;
    if (hidden) {
      node.dataset.pzFeedSeenHidden = 'true';
      node.dataset.pzFeedSeenReason = reason;
    } else {
      delete node.dataset.pzFeedSeenHidden;
      delete node.dataset.pzFeedSeenReason;
    }
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function createButton(label, className, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.pzOwned = 'true';
    button.dataset.pzFeedSeenOwned = 'true';
    button.addEventListener('click', event => {
      event.stopPropagation();
      handler(event);
    });
    button.setAttribute('aria-label', label);
    return button;
  }

  function updateControls() {
    const toggleLabel = preferences.enabled ? 'Só não vistos: ligado' : 'Mostrar posts já vistos';
    for (const control of toggleControls) {
      if (!control.isConnected) {
        toggleControls.delete(control);
        continue;
      }
      control.setAttribute('aria-pressed', String(preferences.enabled));
      control.setAttribute('aria-label', toggleLabel);
      setText(control.querySelector('[data-pz-feed-seen-button-label]'), toggleLabel);
    }
    const clearLabel = seen.size ? `Limpar ${seen.size} posts já vistos` : 'Nenhum post visto para limpar';
    for (const control of [toolbarState?.clear, panelState?.clear]) {
      if (!control) continue;
      control.disabled = !seen.size;
      control.setAttribute('aria-label', clearLabel);
    }
    for (const status of [toolbarState?.status, panelState?.status]) {
      if (!status) continue;
      const {visible, hidden, total} = lastSummary;
      setText(status, preferences.enabled
        ? total ? `${visible} novo${visible === 1 ? '' : 's'} nesta tela · ${hidden} oculto${hidden === 1 ? '' : 's'}`
          : 'Aguardando posts…'
        : `${seen.size} marcado${seen.size === 1 ? '' : 's'} · filtro desligado`);
    }
  }

  function makeToggle(handler) {
    const button = createButton('', 'pz-feed-seen-toggle', handler);
    const icon = document.createElement('span');
    icon.className = 'pz-feed-seen-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '◉';
    const label = document.createElement('span');
    label.dataset.pzFeedSeenButtonLabel = 'true';
    button.append(icon, label);
    toggleControls.add(button);
    return button;
  }

  function makeClear(handler) {
    return createButton('Limpar histórico de posts vistos', 'pz-feed-seen-clear', handler);
  }

  function toggleEnabled() {
    preferences.enabled = !preferences.enabled;
    savePreferences();
    announce('toggle');
    scheduleScan(0, true);
  }

  function clearSeen() {
    if (!seen.size) return;
    seen.clear();
    saveSeen();
    announce('clear');
    scheduleScan(0, true);
  }

  function mountToolbar(feedRoot) {
    if (toolbarState?.node?.isConnected && feedRoot.contains(toolbarState.node)) {
      updateControls();
      return;
    }
    toolbarState?.node?.remove();

    const node = document.createElement('section');
    node.id = TOOLBAR_ID;
    node.dataset.pzOwned = 'true';
    node.dataset.pzFeedSeenOwned = 'true';
    node.setAttribute('aria-label', 'Filtro de posts vistos');

    const copy = document.createElement('div');
    copy.className = 'pz-feed-seen-copy';
    const title = document.createElement('strong');
    title.textContent = 'Feed sem repetidos';
    const hint = document.createElement('small');
    hint.textContent = 'Mostre apenas o que você ainda não abriu.';
    copy.append(title, hint);

    const actions = document.createElement('div');
    actions.className = 'pz-feed-seen-actions';
    const toggle = makeToggle(toggleEnabled);
    const clear = makeClear(clearSeen);
    actions.append(toggle, clear);

    const status = document.createElement('span');
    status.className = 'pz-feed-seen-status';
    status.setAttribute('aria-live', 'polite');
    node.append(copy, actions, status);

    const anchor = feedRoot.querySelector('[data-pz-feed-actions-block]')
      || feedRoot.querySelector('[aria-label="feed tabs"]')?.parentElement;
    if (anchor?.parentElement) anchor.parentElement.insertBefore(node, anchor);
    else feedRoot.prepend(node);
    toolbarState = {node, toggle, clear, status};
    updateControls();
  }

  function mountPanelSettings() {
    const panel = document.getElementById('pz-panel');
    if (!panel) return;
    if (panelState?.node?.isConnected && panel.contains(panelState.node)) {
      updateControls();
      return;
    }
    panelState?.node?.remove();

    const node = document.createElement('section');
    node.dataset.pzOwned = 'true';
    node.dataset.pzFeedSeenOwned = 'true';
    node.dataset.pzFeedSeenSettings = 'true';
    const title = document.createElement('strong');
    title.textContent = 'Feed sem repetidos';
    const hint = document.createElement('p');
    hint.textContent = 'Esconde posts que você já abriu e mantém o histórico neste navegador.';
    const toggle = makeToggle(toggleEnabled);
    const clear = makeClear(clearSeen);
    const status = document.createElement('span');
    status.className = 'pz-feed-seen-status';
    status.setAttribute('aria-live', 'polite');
    node.append(title, hint, toggle, clear, status);
    panel.append(node);
    panelState = {node, toggle, clear, status};
    updateControls();
  }

  function applyFeedFilter(feedRoot) {
    const entries = collectEntries(feedRoot);
    const nextManaged = new Set(entries.map(entry => entry.node));
    for (const node of managedNodes) if (!nextManaged.has(node)) clearNodeState(node);
    managedNodes.clear();
    for (const node of nextManaged) managedNodes.add(node);

    const unique = new Set();
    let visible = 0;
    let hidden = 0;
    for (const entry of entries) {
      const alreadySeen = seen.has(entry.key);
      const duplicate = !alreadySeen && unique.has(entry.key);
      const shouldHide = preferences.enabled && (alreadySeen || duplicate);
      const reason = alreadySeen ? 'seen' : 'duplicate';
      setNodeState(entry.node, entry.key, shouldHide, reason);
      if (shouldHide) hidden++;
      else visible++;
      unique.add(entry.key);
    }
    lastSummary = {visible, hidden, total: entries.length};
    feedRoot.dataset.pzFeedSeenReady = 'true';
    mountToolbar(feedRoot);
    updateControls();
  }

  function scan() {
    scanTimer = 0;
    scanFrame = 0;
    if (!scanDirty || document.hidden) return;
    scanDirty = false;
    mountPanelSettings();

    if (!isFeedRoute()) {
      if (activeFeedRoot) delete activeFeedRoot.dataset.pzFeedSeenReady;
      activeFeedRoot = null;
      clearManagedState();
      toolbarState?.node?.remove();
      toolbarState = null;
      lastSummary = {visible: 0, hidden: 0, total: 0};
      updateControls();
      return;
    }

    const feedRoot = findFeedRoot();
    if (!feedRoot) {
      // SPA transitions can briefly remove the feed before React mounts the
      // next version. Do not leave stale hidden cards or a detached toolbar
      // during that gap.
      if (activeFeedRoot) delete activeFeedRoot.dataset.pzFeedSeenReady;
      activeFeedRoot = null;
      clearManagedState();
      toolbarState?.node?.remove();
      toolbarState = null;
      lastSummary = {visible: 0, hidden: 0, total: 0};
      updateControls();
      return;
    }
    if (activeFeedRoot && activeFeedRoot !== feedRoot) {
      delete activeFeedRoot.dataset.pzFeedSeenReady;
      clearManagedState();
    }
    activeFeedRoot = feedRoot;
    applyFeedFilter(feedRoot);
  }

  function scheduleScan(delay = 120, immediate = false) {
    scanDirty = true;
    if (document.hidden) return;
    if (immediate && scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = 0;
    }
    if (scanTimer || scanFrame) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      if (document.hidden || scanFrame) return;
      scanFrame = requestAnimationFrame(scan);
    }, Math.max(0, delay));
  }

  function nodeMayAffectFeed(node) {
    if (!node || node.nodeType !== 1 || node.closest(OWNED_SELECTOR)) return false;
    if (activeFeedRoot?.contains(node)) return true;
    return node.matches(POST_CANDIDATES + ',[data-pz-feed],#feed-search-input,[aria-label="feed tabs"]')
      || !!node.querySelector?.(POST_CANDIDATES + ',[data-pz-feed],#feed-search-input,[aria-label="feed tabs"],a[href*="/post/"],a[href*="/publicacao/"]');
  }

  function onMutations(changes) {
    if (changes.some(change => nodeMayAffectFeed(change.target)
      || [...change.addedNodes, ...change.removedNodes].some(nodeMayAffectFeed))) scheduleScan();
  }

  function markSeen(key) {
    if (!key || seen.has(key)) return;
    seen.set(key, Date.now());
    trimSeen();
    saveSeen();
    announce('mark');
    scheduleScan(0, true);
  }

  function onPostActivation(event) {
    if (!isFeedRoute()) return;
    const link = event.target?.closest?.('a[href]');
    if (!link || link.closest(OWNED_SELECTOR)) return;
    const feedRoot = activeFeedRoot || findFeedRoot();
    if (!feedRoot?.contains(link)) return;
    markSeen(postKeyFromHref(link.getAttribute('href')));
  }

  function patchHistory() {
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      if (original.__pzFeedSeenWrapped) continue;
      const wrapped = function(...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event('packzin:feed-seen-route-change'));
        return result;
      };
      wrapped.__pzFeedSeenWrapped = true;
      history[method] = wrapped;
    }
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      [data-pz-feed-seen-hidden="true"] { display: none !important; }
      #${TOOLBAR_ID}, #pz-panel [data-pz-feed-seen-settings] {
        box-sizing: border-box;
        color: var(--pz-text, #242034);
        font: 600 13px/1.35 Roboto, Arial, sans-serif;
      }
      #${TOOLBAR_ID} {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 12px;
        width: 100%;
        margin: 0 0 14px;
        padding: 12px 14px;
        border: 1px solid var(--pz-line, #ded8ea);
        border-radius: 16px;
        background: linear-gradient(120deg, var(--pz-soft, #efe6ff), var(--pz-surface, #fff));
        box-shadow: 0 8px 22px #00000012;
      }
      #${TOOLBAR_ID} .pz-feed-seen-copy,
      #pz-panel [data-pz-feed-seen-settings] { min-width: 0; }
      #${TOOLBAR_ID} .pz-feed-seen-copy { display: grid; gap: 2px; }
      #${TOOLBAR_ID} strong,
      #pz-panel [data-pz-feed-seen-settings] strong { color: var(--pz-text, #242034); font-weight: 800; }
      #${TOOLBAR_ID} small,
      #pz-panel [data-pz-feed-seen-settings] p,
      .pz-feed-seen-status { color: var(--pz-muted, #625b73); }
      #${TOOLBAR_ID} small { font-size: 11px; font-weight: 500; }
      .pz-feed-seen-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
      .pz-feed-seen-toggle,
      .pz-feed-seen-clear,
      #pz-panel [data-pz-feed-seen-settings] button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        min-height: 34px;
        padding: 7px 11px;
        border: 1px solid var(--pz-line, #ded8ea);
        border-radius: 10px;
        background: var(--pz-surface, #fff);
        color: var(--pz-text, #242034);
        cursor: pointer;
        font: 700 12px/1.2 Roboto, Arial, sans-serif;
        transition: background .16s ease, border-color .16s ease, transform .16s ease;
      }
      .pz-feed-seen-toggle[aria-pressed="true"] {
        border-color: var(--pz-accent, #7033c6);
        background: var(--pz-soft, #efe6ff);
        color: var(--pz-accent, #7033c6);
      }
      .pz-feed-seen-toggle:hover,
      .pz-feed-seen-clear:hover:not(:disabled),
      #pz-panel [data-pz-feed-seen-settings] button:hover:not(:disabled) {
        border-color: var(--pz-accent, #7033c6);
        transform: translateY(-1px);
      }
      .pz-feed-seen-clear:disabled,
      #pz-panel [data-pz-feed-seen-settings] button:disabled { cursor: not-allowed; opacity: .5; }
      .pz-feed-seen-icon { color: var(--pz-accent, #7033c6); font-size: 14px; line-height: 1; }
      #${TOOLBAR_ID} .pz-feed-seen-status { grid-column: 1 / -1; margin-top: -2px; font-size: 11px; font-weight: 700; }
      #pz-panel [data-pz-feed-seen-settings] {
        display: grid;
        gap: 8px;
        margin-top: 14px;
        padding-top: 14px;
        border-top: 1px solid var(--pz-line, #ded8ea);
      }
      #pz-panel [data-pz-feed-seen-settings] p { margin: 0; font-size: 12px; font-weight: 500; }
      #pz-panel [data-pz-feed-seen-settings] .pz-feed-seen-toggle,
      #pz-panel [data-pz-feed-seen-settings] .pz-feed-seen-clear { width: 100%; }
      #pz-panel [data-pz-feed-seen-settings] .pz-feed-seen-status { font-size: 11px; }
      @media (max-width: 640px) {
        #${TOOLBAR_ID} { grid-template-columns: 1fr; }
        .pz-feed-seen-actions { justify-content: stretch; }
        .pz-feed-seen-actions button { flex: 1 1 150px; }
      }
      @media (prefers-reduced-motion: reduce) {
        #${TOOLBAR_ID} *, #pz-panel [data-pz-feed-seen-settings] * { transition: none !important; }
      }
    `;
    document.head.append(style);
  }

  function cleanup() {
    if (scanTimer) clearTimeout(scanTimer);
    if (scanFrame) cancelAnimationFrame(scanFrame);
    observer?.disconnect();
    clearManagedState();
    toolbarState?.node?.remove();
    if (activeFeedRoot) delete activeFeedRoot.dataset.pzFeedSeenReady;
    delete root.dataset.pzFeedSeenEnabled;
    delete root.dataset.pzFeedSeenCount;
  }

  loadPreferences();
  loadSeen();
  installStyles();
  announce('init');

  const routeChanged = () => {
    const key = currentPostKey();
    if (key) markSeen(key);
    scheduleScan(0, true);
  };
  patchHistory();
  window.addEventListener('packzin:feed-seen-route-change', routeChanged);
  window.addEventListener('popstate', routeChanged);
  window.addEventListener('hashchange', routeChanged);
  document.addEventListener('click', onPostActivation, true);
  document.addEventListener('auxclick', event => {
    if (event.button === 1) onPostActivation(event);
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleScan(0, true);
  });
  window.addEventListener('pageshow', () => scheduleScan(0, true));
  window.addEventListener('pagehide', event => {
    if (!event.persisted) cleanup();
  });

  observer = new MutationObserver(onMutations);
  if (document.body) observer.observe(document.body, {childList: true, subtree: true});
  scan();
})();
