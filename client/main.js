// Scribble Siege client: screens, networking glue, input and the frame loop.

import {
  UNITS, TERRAIN, TICK_RATE, COLS, ROWS, VISIBILITY, defaultSettings, MAX_UNITS_PER_PLAYER,
} from '../shared/config.js';
import { decodeGrid, emptyGrid } from '../shared/draft.js';
import { HostNet, GuestNet, SnapshotBuffer } from './net.js';
import { Renderer } from './render.js';
import { Editor } from './editor.js';
import { unitIcon, TEAM } from './sprites.js';

const $ = (id) => document.getElementById(id);
const TERRAIN_CHIP = { wall: '#6b6f76', water: '#86bfdf', mud: '#a98257', bramble: '#86a95c' };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
// Marks the room this tab is hosting, so a reload re-opens it.
const hosting = {
  get() { try { return sessionStorage.getItem('ss-hosting'); } catch { return null; } },
  set(code) {
    try { if (code) sessionStorage.setItem('ss-hosting', code); else sessionStorage.removeItem('ss-hosting'); } catch { /* storage unavailable */ }
  },
};
// Seat tokens are per browser tab, so two tabs can play against each other.
const seats = {
  get(code) { try { return sessionStorage.getItem(`ss-token-${code}`); } catch { return null; } },
  set(code, v) { try { sessionStorage.setItem(`ss-token-${code}`, v); } catch { /* storage unavailable */ } },
};

const state = {
  code: null,
  token: null,
  side: 0,
  hosting: false,
  room: null,
  phase: null,
  skew: 0, // serverNow - Date.now()
  editor: null,
  opDraft: null, // { units, grid }
  result: null,
  battleStartsLocal: 0,
  tab: 'units',
  eraser: false,
  pointer: null,
  drawing: false,
  rightErase: false,
  sendTimer: null,
  lastSent: 0,
  sentVersion: -1,
  terrainShown: -1,
  opTerrainVersion: 0,
  resultsCollapsed: false,
  lastBlockedToast: 0,
};

const snaps = new SnapshotBuffer(1000 / TICK_RATE, 110);
let renderer = null;

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = `toast${err ? ' err' : ''}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
// The host's browser runs the room; guests connect to it peer-to-peer (see net.js).
let net = null;
const netHandlers = {
  onOpen() {
    $('connBanner').hidden = true;
    net.send({ t: 'join', name: myName(), token: state.token });
  },
  onClose() {
    if (net && !net.closed) $('connBanner').hidden = false;
  },
  onSnapshot(s) { snaps.push(s); },
  onMessage,
  onFatal(text) {
    toast(text, true);
    goHome();
  },
};

function send(msg) { net?.send(msg); }

function setHomeBusy(text) {
  $('homeStatus').textContent = text || '';
  $('createBtn').disabled = !!text;
  $('joinBtn').disabled = !!text;
}

function hostRoom(code = null) {
  net?.close();
  state.code = code;
  state.token = code ? seats.get(code) : null;
  state.hosting = true;
  setHomeBusy('Opening a room…');
  net = new HostNet(netHandlers, code);
  net.connect();
}

function joinRoom(code) {
  net?.close();
  state.code = code;
  state.token = seats.get(code);
  state.hosting = false;
  setHomeBusy('Connecting to your friend…');
  net = new GuestNet(netHandlers, code);
  net.connect();
}

/** The host's last-used rules, reapplied when they open a new room. */
function savedRules() {
  try { return JSON.parse(store.get('ss-rules') || 'null'); } catch { return null; }
}

function myName() {
  let n = $('nameInput').value.trim();
  if (!n) {
    n = `Doodler ${100 + Math.floor(Math.random() * 900)}`;
    $('nameInput').value = n;
  }
  store.set('ss-name', n);
  return n;
}

function onMessage(msg) {
  switch (msg.t) {
    case 'joined':
      state.side = msg.side;
      state.token = msg.token;
      state.code = msg.room.code;
      seats.set(state.code, msg.token);
      history.replaceState(null, '', `${location.pathname}?room=${state.code}`);
      setHomeBusy('');
      {
        const rules = state.hosting ? savedRules() : null;
        applyRoom(msg.room);
        if (state.hosting) {
          hosting.set(state.code);
          if (rules && msg.room.phase === 'lobby') send({ t: 'settings', settings: rules });
        }
      }
      break;
    case 'room':
      applyRoom(msg.room);
      break;
    case 'yourDraft':
      ensureEditor();
      state.editor.load(msg.units, decodeGrid(msg.terrain));
      state.sentVersion = state.editor.version;
      break;
    case 'opDraft':
      state.opDraft = { units: msg.units, grid: decodeGrid(msg.terrain) };
      state.opTerrainVersion++;
      break;
    case 'draftReject':
      toast(msg.reason, true);
      break;
    case 'battleStart':
      startBattleView(msg);
      break;
    case 'ev':
      snaps.pushEvents(msg.tick, msg.events);
      break;
    case 'battleEnd':
      state.result = msg.result;
      break;
    case 'notice':
      toast(msg.msg);
      break;
    case 'error':
      toast(msg.msg, true);
      if (msg.fatal) goHome();
      break;
    case 'kicked':
      toast('The host removed you from the room', true);
      goHome();
      break;
    default:
  }
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function show(screen) {
  for (const id of ['home', 'lobby', 'game']) $(id).hidden = id !== screen;
  if (screen === 'game' && renderer) requestAnimationFrame(() => renderer.resize());
}

function goHome() {
  net?.close();
  net = null;
  hosting.set(null);
  state.hosting = false;
  setHomeBusy('');
  state.code = null;
  state.token = null;
  state.room = null;
  state.phase = null;
  state.editor = null;
  state.opDraft = null;
  $('connBanner').hidden = true;
  history.replaceState(null, '', location.pathname);
  show('home');
}

function me() { return state.room?.players[state.side] || null; }
function opp() { return state.room?.players[1 - state.side] || null; }
function amHost() { return !!me()?.host; }

function applyRoom(room) {
  const prev = state.phase;
  state.room = room;
  state.phase = room.phase;
  state.skew = room.serverNow - Date.now();
  if (room.players[state.side]?.host) store.set('ss-rules', JSON.stringify(room.settings));
  if (room.result) state.result = room.result;
  if (state.editor) {
    state.editor.setSettings(room.settings);
    state.editor.locked = room.phase !== 'draw' || !!me()?.ready;
  }
  if (room.phase !== prev) enterPhase(room.phase);
  if (room.phase === 'lobby') { show('lobby'); renderLobby(); } else { show('game'); updateGameChrome(); }
}

function enterPhase(phase) {
  if (phase === 'lobby') {
    state.opDraft = null;
  } else if (phase === 'draw') {
    ensureEditor();
    state.editor.locked = false;
    state.opDraft = null;
    state.terrainShown = -1;
    state.resultsCollapsed = false;
    snaps.reset();
    renderer.clearDecals();
    renderPalette();
  } else if (phase === 'results') {
    state.resultsCollapsed = false;
  }
}

function ensureEditor() {
  if (!state.editor || state.editor.side !== state.side) {
    state.editor = new Editor(state.side, state.room.settings);
    state.editor.radius = Number($('brushSize').value);
    state.sentVersion = -1;
  }
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
function initHome() {
  $('nameInput').value = store.get('ss-name') || '';
  const params = new URLSearchParams(location.search);
  const code = (params.get('room') || '').toUpperCase().slice(0, 4);
  if (code) $('codeInput').value = code;

  $('createBtn').addEventListener('click', () => {
    myName();
    hostRoom();
  });
  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const c = $('codeInput').value.trim().toUpperCase();
    if (c.length !== 4) { toast('Room codes are 4 letters', true); return; }
    myName();
    joinRoom(c);
  });
  $('codeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  });
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
let settingsTimer = null;

function initLobby() {
  const ut = $('unitCosts');
  UNITS.forEach((u, i) => {
    const tr = document.createElement('tr');
    const icon = document.createElement('td');
    icon.className = 'icon';
    icon.appendChild(unitIcon(i, 0, 40));
    tr.appendChild(icon);
    const nm = document.createElement('td');
    nm.className = 'nm';
    nm.innerHTML = `${u.name}<small></small>`;
    nm.querySelector('small').textContent = u.desc;
    tr.appendChild(nm);
    const td = document.createElement('td');
    const inp = document.createElement('input');
    inp.type = 'number'; inp.min = '0'; inp.step = '0.5'; inp.dataset.unit = u.key;
    inp.setAttribute('aria-label', `${u.name} cost`);
    td.appendChild(inp);
    tr.appendChild(td);
    ut.appendChild(tr);
  });
  const tt = $('terrainCosts');
  for (const t of TERRAIN) {
    if (!t) continue;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="icon"><span class="terrain-chip" style="background:${TERRAIN_CHIP[t.key]}"></span></td><td class="nm">${t.name}<small></small></td>`;
    tr.querySelector('small').textContent = t.desc;
    const td = document.createElement('td');
    const inp = document.createElement('input');
    inp.type = 'number'; inp.min = '0'; inp.step = '0.01'; inp.dataset.terrain = t.key;
    inp.setAttribute('aria-label', `${t.name} cost per tile`);
    td.appendChild(inp);
    tr.appendChild(td);
    tt.appendChild(tr);
  }

  const onEdit = () => {
    if (!amHost()) return;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => send({ t: 'settings', settings: readSettingsForm() }), 300);
  };
  for (const el of document.querySelectorAll('#lobby input, #lobby select')) {
    el.addEventListener('input', onEdit);
    el.addEventListener('change', onEdit);
  }
  $('resetCostsBtn').addEventListener('click', () => {
    if (!amHost()) return;
    const s = readSettingsForm();
    s.costs = defaultSettings().costs;
    send({ t: 'settings', settings: s });
  });
  $('startBtn').addEventListener('click', () => send({ t: 'start' }));
  $('leaveBtn').addEventListener('click', goHome);
  $('copyLinkBtn').addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}?room=${state.code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied');
    } catch {
      toast(link);
    }
  });
}

function readSettingsForm() {
  const s = {
    budget: Number($('setBudget').value),
    visibility: $('setVisibility').value,
    drawTime: Number($('setDrawTime').value),
    costs: { units: {}, terrain: {} },
  };
  for (const inp of document.querySelectorAll('#unitCosts input')) s.costs.units[inp.dataset.unit] = Number(inp.value);
  for (const inp of document.querySelectorAll('#terrainCosts input')) s.costs.terrain[inp.dataset.terrain] = Number(inp.value);
  return s;
}

function setIfIdle(el, value) {
  if (document.activeElement !== el) el.value = value;
}

function renderLobby() {
  const room = state.room;
  const host = amHost();
  $('lobbyCode').textContent = room.code;

  const list = $('playerList');
  list.innerHTML = '';
  room.players.forEach((p, side) => {
    const li = document.createElement('li');
    if (p) {
      li.className = 'filled';
      li.innerHTML = `<span class="swatch s${side}"></span><span class="pname"></span>`;
      li.querySelector('.pname').textContent = p.name;
      const tags = [];
      if (side === state.side) tags.push(['you', 'You']);
      if (p.host) tags.push(['', 'Host']);
      if (!p.connected) tags.push(['off', 'Offline']);
      for (const [cls, txt] of tags) {
        const t = document.createElement('span');
        t.className = `tag ${cls}`;
        t.textContent = txt;
        li.appendChild(t);
      }
      if (host && side !== state.side) {
        const sp = document.createElement('span');
        sp.className = 'spacer';
        li.appendChild(sp);
        const kick = document.createElement('button');
        kick.className = 'btn small ghost';
        kick.textContent = 'Kick';
        kick.onclick = () => send({ t: 'kick' });
        li.appendChild(kick);
      }
    } else {
      li.innerHTML = `<span class="swatch s${side}" style="opacity:.3"></span><span class="hint">Waiting for a friend… share the invite link</span>`;
    }
    list.appendChild(li);
  });

  const full = room.players.every((p) => p && p.connected);
  $('startBtn').hidden = !host;
  $('startBtn').disabled = !full;
  $('startHint').textContent = host
    ? (full ? 'Both players are here. Start whenever you like.' : 'You need a second player to start.')
    : 'Waiting for the host to start…';

  $('rulesWho').textContent = host ? "(you're the host)" : '(set by the host)';
  const s = room.settings;
  setIfIdle($('setBudget'), s.budget);
  setIfIdle($('setVisibility'), s.visibility);
  const dt = $('setDrawTime');
  if (![...dt.options].some((o) => Number(o.value) === s.drawTime)) {
    const o = document.createElement('option');
    o.value = String(s.drawTime);
    o.textContent = `${s.drawTime} seconds`;
    dt.appendChild(o);
  }
  setIfIdle(dt, String(s.drawTime));
  for (const inp of document.querySelectorAll('#unitCosts input')) setIfIdle(inp, s.costs.units[inp.dataset.unit]);
  for (const inp of document.querySelectorAll('#terrainCosts input')) setIfIdle(inp, s.costs.terrain[inp.dataset.terrain]);
  for (const el of document.querySelectorAll('#lobby .rules input, #lobby .rules select')) el.disabled = !host;
  $('resetCostsBtn').hidden = !host;
}

// ---------------------------------------------------------------------------
// Game chrome (top bar, palette, results)
// ---------------------------------------------------------------------------
const fmt = (n) => String(Math.round(n * 10) / 10);

function updateGameChrome() {
  const room = state.room;
  const phase = room.phase;
  $('phaseLabel').textContent = phase === 'draw' ? 'Draw your army' : phase === 'battle' ? 'Battle!' : 'Battle over';
  const vs = $('vsLabel');
  vs.innerHTML = '';
  room.players.forEach((p, i) => {
    if (i === 1) vs.append(' vs ');
    const s = document.createElement('span');
    s.className = `s${i}`;
    s.textContent = p ? p.name : '…';
    vs.appendChild(s);
  });
  $('toLobbyBtn').hidden = false;
  $('palette').hidden = phase !== 'draw';
  $('battleHud').hidden = phase === 'draw';
  $('stage').classList.toggle('locked', phase !== 'draw' || !!me()?.ready);

  if (phase === 'draw') {
    const ready = !!me()?.ready;
    const btn = $('readyBtn');
    btn.textContent = ready ? 'Ready! (click to edit)' : 'Ready!';
    btn.classList.toggle('ready-on', ready);
    const o = opp();
    $('readyHint').textContent = ready
      ? `Waiting for ${o ? o.name : 'opponent'}…`
      : o && o.ready ? `${o.name} is ready!` : '';
  }
  if (phase === 'results') renderResults(); else $('results').hidden = true;
  if (phase !== 'battle') $('countdown').hidden = true;
  $('battleHud').querySelector('.s0 .hud-name').textContent = room.players[0]?.name || '';
  $('battleHud').querySelector('.hud-side.s1 .hud-name').textContent = room.players[1]?.name || '';
  if (renderer) renderer.resize();
}

function renderPalette() {
  const box = $('paletteItems');
  box.innerHTML = '';
  const ed = state.editor;
  const s = state.room.settings;
  if (state.tab === 'units') {
    UNITS.forEach((u, i) => {
      const b = document.createElement('button');
      b.className = 'item';
      b.title = `${u.name} (${i + 1}): ${u.desc}`;
      b.dataset.kind = 'unit';
      b.dataset.index = String(i);
      b.appendChild(unitIcon(i, state.side, 44));
      const n = document.createElement('span'); n.textContent = u.name; b.appendChild(n);
      const c = document.createElement('span'); c.className = 'cost'; c.textContent = fmt(s.costs.units[u.key]); b.appendChild(c);
      b.onclick = () => { ed.tool = { kind: 'unit', type: i }; state.eraser = false; syncToolUI(); };
      box.appendChild(b);
    });
  } else {
    TERRAIN.forEach((t, id) => {
      if (!t) return;
      const b = document.createElement('button');
      b.className = 'item';
      b.title = `${t.name} (${id}): ${t.desc}`;
      b.dataset.kind = 'terrain';
      b.dataset.index = String(id);
      const chip = document.createElement('span'); chip.className = 'chip'; chip.style.background = TERRAIN_CHIP[t.key]; b.appendChild(chip);
      const n = document.createElement('span'); n.textContent = t.name; b.appendChild(n);
      const c = document.createElement('span'); c.className = 'cost'; c.textContent = `${s.costs.terrain[t.key]}/tile`; b.appendChild(c);
      b.onclick = () => { ed.tool = { kind: 'terrain', id }; state.eraser = false; syncToolUI(); };
      box.appendChild(b);
    });
  }
  syncToolUI();
}

function syncToolUI() {
  const ed = state.editor;
  if (!ed) return;
  if (state.eraser) ed.tool = { kind: 'erase' };
  else if (ed.tool.kind === 'erase') ed.tool = { kind: 'unit', type: 0 };
  for (const b of document.querySelectorAll('#paletteItems .item')) {
    const idx = Number(b.dataset.index);
    const on = !state.eraser && ((b.dataset.kind === 'unit' && ed.tool.kind === 'unit' && ed.tool.type === idx)
      || (b.dataset.kind === 'terrain' && ed.tool.kind === 'terrain' && ed.tool.id === idx));
    b.classList.toggle('active', on);
  }
  $('eraseBtn').classList.toggle('active', state.eraser);
}

let lastBudgetKey = '';
function updateBudget() {
  const ed = state.editor;
  if (!ed) return;
  const key = `${ed.cost}|${ed.budget}|${ed.units.length}`;
  if (key === lastBudgetKey) return;
  lastBudgetKey = key;
  $('budgetText').textContent = `${fmt(ed.cost)} / ${ed.budget}`;
  const f = Math.min(1, ed.cost / Math.max(1, ed.budget));
  $('budgetFill').style.width = `${f * 100}%`;
  $('budgetFill').classList.toggle('full', f >= 0.999);
  $('unitCountText').textContent = `${ed.units.length} unit${ed.units.length === 1 ? '' : 's'}${ed.units.length >= MAX_UNITS_PER_PLAYER ? ' (max)' : ''}`;
  const left = ed.budget - ed.cost;
  for (const b of document.querySelectorAll('#paletteItems .item[data-kind="unit"]')) {
    const u = UNITS[Number(b.dataset.index)];
    b.classList.toggle('unaffordable', state.room.settings.costs.units[u.key] > left + 1e-6);
  }
}

function renderResults() {
  const r = state.result;
  const el = $('results');
  if (!r) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle('collapsed', state.resultsCollapsed);
  const players = state.room.players;
  const name = (i) => players[i]?.name || TEAM[i].name;
  el.innerHTML = '';
  if (state.resultsCollapsed) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = 'Show results';
    b.onclick = () => { state.resultsCollapsed = false; renderResults(); };
    el.appendChild(b);
    return;
  }
  const h = document.createElement('h2');
  if (r.winner === -1) h.textContent = "It's a draw!";
  else {
    h.textContent = `${name(r.winner)} wins!`;
    h.style.color = r.winner === 0 ? 'var(--teal-dark)' : 'var(--coral-dark)';
  }
  el.appendChild(h);
  const reason = document.createElement('p');
  reason.className = 'reason';
  reason.textContent = `${r.reason} after ${Math.floor(r.time / 60)}:${String(r.time % 60).padStart(2, '0')}`;
  el.appendChild(reason);
  const table = document.createElement('table');
  const head = document.createElement('tr');
  head.innerHTML = '<th></th><th></th><th></th>';
  head.children[1].textContent = name(0);
  head.children[1].style.color = 'var(--teal-dark)';
  head.children[2].textContent = name(1);
  head.children[2].style.color = 'var(--coral-dark)';
  table.appendChild(head);
  const rows = [
    ['Units drawn', r.start], ['Survivors', r.survivors], ['Kills', r.kills],
    ['HP healed', r.healed], ['Shots fired', r.shots],
  ];
  for (const [label, v] of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${label}</td><td>${v[0]}</td><td>${v[1]}</td>`;
    table.appendChild(tr);
  }
  el.appendChild(table);
  const actions = document.createElement('div');
  actions.className = 'actions';
  if (amHost()) {
    const re = document.createElement('button');
    re.className = 'btn primary';
    re.textContent = 'Rematch (keep armies)';
    re.onclick = () => send({ t: 'rematch' });
    const lb = document.createElement('button');
    lb.className = 'btn';
    lb.textContent = 'Change rules';
    lb.onclick = () => send({ t: 'lobby' });
    actions.append(re, lb);
  } else {
    const w = document.createElement('span');
    w.className = 'hint';
    w.textContent = 'Waiting for the host to start a rematch…';
    actions.appendChild(w);
  }
  const hide = document.createElement('button');
  hide.className = 'btn ghost';
  hide.textContent = 'View battlefield';
  hide.onclick = () => { state.resultsCollapsed = true; renderResults(); };
  actions.appendChild(hide);
  el.appendChild(actions);
}

function initPalette() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
      const ed = state.editor;
      if (ed) {
        state.eraser = false;
        ed.tool = state.tab === 'units' ? { kind: 'unit', type: 0 } : { kind: 'terrain', id: 1 };
      }
      renderPalette();
    });
  }
  $('brushSize').addEventListener('input', (e) => { if (state.editor) state.editor.radius = Number(e.target.value); });
  $('eraseBtn').addEventListener('click', () => { state.eraser = !state.eraser; syncToolUI(); });
  $('undoBtn').addEventListener('click', () => state.editor?.undo());
  $('clearBtn').addEventListener('click', () => {
    const b = $('clearBtn');
    if (b.dataset.confirm === '1') {
      state.editor?.clear();
      b.dataset.confirm = '';
      b.textContent = 'Clear';
    } else {
      b.dataset.confirm = '1';
      b.textContent = 'Really clear?';
      setTimeout(() => { b.dataset.confirm = ''; b.textContent = 'Clear'; }, 2500);
    }
  });
  $('readyBtn').addEventListener('click', () => {
    const ready = !!me()?.ready;
    if (!ready) flushDraft();
    send({ t: 'ready', ready: !ready });
  });
  // Exit the battlefield. Mid-match it ends things for both players, so ask for a second click.
  {
    const btn = $('toLobbyBtn');
    let armedUntil = 0;
    let resetTimer = null;
    btn.addEventListener('click', () => {
      const midMatch = state.phase === 'draw' || state.phase === 'battle';
      if (midMatch && Date.now() > armedUntil) {
        armedUntil = Date.now() + 3000;
        btn.textContent = 'Click again to exit';
        btn.classList.add('armed');
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => { btn.textContent = 'Exit to lobby'; btn.classList.remove('armed'); }, 3000);
        return;
      }
      armedUntil = 0;
      clearTimeout(resetTimer);
      btn.textContent = 'Exit to lobby';
      btn.classList.remove('armed');
      send({ t: 'lobby' });
    });
  }

  window.addEventListener('keydown', (e) => {
    if (state.phase !== 'draw' || !state.editor) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); state.editor.undo(); return; }
    if (e.key === 'e' || e.key === 'E') { state.eraser = !state.eraser; syncToolUI(); return; }
    if (e.key === '[' || e.key === ']') {
      const s = $('brushSize');
      s.value = String(Number(s.value) + (e.key === ']' ? 6 : -6));
      state.editor.radius = Number(s.value);
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= 9) {
      const items = document.querySelectorAll('#paletteItems .item');
      items[n - 1]?.click();
    }
  });
}

// ---------------------------------------------------------------------------
// Draft syncing
// ---------------------------------------------------------------------------
function sendDraft() {
  clearTimeout(state.sendTimer);
  state.sendTimer = null;
  const ed = state.editor;
  if (!ed || state.phase !== 'draw') return;
  state.lastSent = performance.now();
  state.sentVersion = ed.version;
  send({ t: 'draft', ...ed.toWire() });
}

function scheduleDraft() {
  if (state.sendTimer) return;
  const wait = Math.max(0, 250 - (performance.now() - state.lastSent));
  state.sendTimer = setTimeout(sendDraft, wait);
}

function flushDraft() {
  if (state.editor && state.editor.version !== state.sentVersion) sendDraft();
}

// ---------------------------------------------------------------------------
// Canvas input
// ---------------------------------------------------------------------------
function initCanvas() {
  const canvas = $('stage');
  renderer = new Renderer(canvas);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    const ed = state.editor;
    if (state.phase !== 'draw' || !ed || ed.locked) return;
    if (e.button !== 0 && e.button !== 2) return;
    canvas.setPointerCapture(e.pointerId);
    state.drawing = true;
    state.rightErase = e.button === 2;
    const p = renderer.toWorld(e.clientX, e.clientY);
    state.pointer = p;
    ed.begin(p.x, p.y, state.rightErase);
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = renderer.toWorld(e.clientX, e.clientY);
    state.pointer = p;
    if (state.drawing && state.editor) {
      let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (!evs.length) evs = [e];
      for (const ce of evs) {
        const q = renderer.toWorld(ce.clientX, ce.clientY);
        state.editor.move(q.x, q.y, state.rightErase);
      }
    }
  });
  const end = () => {
    if (!state.drawing) return;
    state.drawing = false;
    const ed = state.editor;
    if (!ed) return;
    ed.end();
    if (ed.blockedReason && performance.now() - state.lastBlockedToast > 2500) {
      toast(ed.blockedReason, true);
      state.lastBlockedToast = performance.now();
    }
    flushDraft();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { if (!state.drawing) state.pointer = null; });
}

// ---------------------------------------------------------------------------
// Battle
// ---------------------------------------------------------------------------
function startBattleView(msg) {
  const grid = emptyGrid();
  for (const d of msg.drafts) {
    const g = decodeGrid(d.terrain);
    for (let i = 0; i < grid.length; i++) if (g[i]) grid[i] = g[i];
  }
  renderer.setTerrain(grid);
  state.terrainShown = -2; // battle terrain, don't overwrite with draft terrain
  renderer.clearDecals();
  snaps.reset();
  state.result = null;
  state.resultsCollapsed = false;
  state.battleStartsLocal = msg.startsAt - msg.serverNow + Date.now();
  if (state.editor) state.editor.locked = true;
  // Show the armies straight away while the countdown runs.
  state.battlePreview = msg.drafts.map((d, side) => d.units.map(([type, x, y]) => ({
    type, side, x, y, heading: side === 0 ? 0 : Math.PI, attack: 0, hp: 1,
  }))).flat();
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
function draftUnitsView() {
  const ed = state.editor;
  const list = [];
  const vis = state.room.settings.visibility === VISIBILITY.VISIBLE;
  if (vis && state.opDraft) {
    const os = 1 - state.side;
    for (const [type, x, y] of state.opDraft.units) {
      list.push({ type, side: os, x, y, heading: os === 0 ? 0 : Math.PI, attack: 0, ghost: 0.75 });
    }
  }
  for (const u of ed.units) {
    list.push({ type: u.type, side: state.side, x: u.x, y: u.y, heading: state.side === 0 ? 0 : Math.PI, attack: 0 });
  }
  return list;
}

function draftTerrain() {
  const ed = state.editor;
  const vis = state.room.settings.visibility === VISIBILITY.VISIBLE;
  const key = ed.terrainVersion * 1000 + (vis ? state.opTerrainVersion : 0);
  if (key === state.terrainShown) return;
  state.terrainShown = key;
  if (vis && state.opDraft) {
    const g = ed.grid.slice();
    const og = state.opDraft.grid;
    for (let i = 0; i < g.length; i++) if (og[i]) g[i] = og[i];
    renderer.setTerrain(g);
  } else {
    renderer.setTerrain(ed.grid);
  }
}

function setTimer(text, urgent = false) {
  const el = $('timerLabel');
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('urgent', urgent);
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

let lastHud = '';
function updateHud(units) {
  let a = 0;
  let b = 0;
  for (const u of units) if (u.side === 0) a++; else b++;
  const key = `${a}|${b}`;
  if (key === lastHud) return;
  lastHud = key;
  const hud = $('battleHud');
  hud.querySelector('.hud-side.s0 .hud-count').textContent = a;
  hud.querySelector('.hud-side.s1 .hud-count').textContent = b;
  const tot = Math.max(1, a + b);
  hud.querySelector('.hud-fill.s0').style.width = `${(a / tot) * 100}%`;
  hud.querySelector('.hud-fill.s1').style.width = `${(b / tot) * 100}%`;
}

function frame() {
  requestAnimationFrame(frame);
  if ($('game').hidden || !state.room || !renderer) return;
  const phase = state.phase;

  if (phase === 'draw' && state.editor) {
    const ed = state.editor;
    if (ed.version !== state.sentVersion && !ed.locked) scheduleDraft();
    draftTerrain();
    updateBudget();
    const hidden = state.room.settings.visibility === VISIBILITY.HIDDEN;
    let brush = null;
    if (state.pointer && !ed.locked) {
      const p = state.pointer;
      const erase = state.eraser || state.rightErase;
      const r = !erase && ed.tool.kind === 'unit' && ed.radius < UNITS[ed.tool.type].spacing * 0.75
        ? UNITS[ed.tool.type].radius
        : ed.radius;
      brush = { x: p.x, y: p.y, r, erase, ok: erase || ed.pointOk(p.x, p.y) };
    }
    renderer.frame({
      mode: 'draw', mySide: state.side, units: draftUnitsView(), projectiles: [],
      fog: hidden ? 1 - state.side : -1, brush, showZones: true,
    });
    const dl = state.room.drawDeadline;
    if (dl) {
      const left = Math.max(0, (dl - (Date.now() + state.skew)) / 1000);
      setTimer(mmss(Math.ceil(left)), left < 10);
    } else setTimer('');
    return;
  }

  // Battle / results
  for (const ev of snaps.takeDueEvents(snaps.renderTick())) renderer.addEvent(ev);
  const sample = snaps.sample();
  let units = sample ? sample.units : (state.battlePreview || []);
  const projectiles = sample ? sample.projectiles : [];
  if (!sample && phase === 'results') units = [];
  renderer.frame({ mode: 'battle', mySide: state.side, units, projectiles, fog: -1, brush: null, showZones: false });
  updateHud(units);

  if (phase === 'battle') {
    const toGo = (state.battleStartsLocal - Date.now()) / 1000;
    const cd = $('countdown');
    if (toGo > 0) {
      cd.hidden = false;
      const n = String(Math.ceil(toGo));
      if (cd.textContent !== n) cd.textContent = n;
    } else if (toGo > -0.7) {
      cd.hidden = false;
      if (cd.textContent !== 'Fight!') cd.textContent = 'Fight!';
    } else cd.hidden = true;
    const t = sample ? Math.max(0, sample.tick / TICK_RATE) : 0;
    setTimer(mmss(t));
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
initHome();
initLobby();
initPalette();
initCanvas();
show('home');
requestAnimationFrame(frame);

// Auto-rejoin when the page is reloaded inside a room we have a seat in.
{
  const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (code && hosting.get() === code) hostRoom(code);
  else if (code && seats.get(code) && store.get('ss-name')) joinRoom(code);
}
