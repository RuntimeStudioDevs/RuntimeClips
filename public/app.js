// RuntimeClips — dashboard: grafo de nodos, cables animados, logs SSE, drawer y reproductor.

const NODE_W = 220;
const NODE_H = 84;
const MAX_LOG_LINES = 500;
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (selector) => document.querySelector(selector);

const state = {
  pipeline: { status: 'idle', output: null },
  nodes: new Map(), // key → nodo (tal como lo envía el servidor)
  order: [],
  logs: [],
  selected: null,
};

const view = { x: 0, y: 0, k: 1 };
const positions = new Map(); // key → { x, y } en coordenadas del mundo
const nodeEls = new Map();
const edges = []; // { from, to, group, path, motions }

const canvas = $('#canvas');
const world = $('#world');
const edgesSvg = $('#edges');
const drawer = $('#drawer');
const logList = $('#log-list');

// ── Utilidades ───────────────────────────────────────────────────────────────

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else el.setAttribute(key, value);
  }
  el.append(...children);
  return el;
}

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

const fmtDuration = (ms) => (ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.toLocaleTimeString('es', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

const elapsed = (node) =>
  node.durationMs ?? (node.status === 'running' && node.startedAt ? Date.now() - node.startedAt : null);

// ── Grafo ────────────────────────────────────────────────────────────────────

// Dos filas: nodos 1-5 arriba, 6-9 abajo.
const defaultPosition = (index) =>
  index < 5 ? { x: 40 + index * 290, y: 60 } : { x: 185 + (index - 5) * 290, y: 280 };

function edgePath(from, to) {
  const a = positions.get(from);
  const b = positions.get(to);
  const sx = a.x + NODE_W;
  const sy = a.y + NODE_H / 2;
  const tx = b.x;
  const ty = b.y + NODE_H / 2;
  const dx = tx - sx;
  const bend = dx >= 0 ? Math.max(50, dx / 2) : Math.min(240, 90 + Math.abs(dx) / 6);
  return `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`;
}

function updateEdgeGeometry(edge) {
  const d = edgePath(edge.from, edge.to);
  edge.path.setAttribute('d', d);
  for (const motion of edge.motions) motion.setAttribute('path', d);
}

function buildGraph(nodes) {
  nodes.forEach((node, index) => {
    positions.set(node.key, defaultPosition(index));

    const el = h('div', { class: 'node', 'data-key': node.key, 'data-status': 'idle' },
      h('span', { class: 'port in' }),
      h('div', { class: 'node-icon', text: node.icon }),
      h('div', { class: 'node-body' },
        h('div', { class: 'node-idx', text: String(index + 1).padStart(2, '0') }),
        h('div', { class: 'node-title', text: node.label }),
        h('div', { class: 'node-sub', text: node.subtitle }),
      ),
      h('div', { class: 'node-state' }),
      h('div', { class: 'node-meta' }),
      h('div', { class: 'node-progress' }, h('i')),
      h('span', { class: 'port out' }),
    );
    placeNode(el, node.key);
    attachNodeDrag(el, node.key);
    world.append(el);
    nodeEls.set(node.key, el);

    if (index > 0) {
      const edge = { from: nodes[index - 1].key, to: node.key, group: svg('g', { class: 'edge-group', 'data-state': 'idle' }), path: svg('path', { class: 'edge' }), motions: [] };
      edge.group.append(edge.path);
      for (const begin of ['0s', '-0.6s']) {
        const pulse = svg('circle', { class: 'pulse', r: 4 });
        const motion = svg('animateMotion', { dur: '1.2s', begin, repeatCount: 'indefinite' });
        pulse.append(motion);
        edge.group.append(pulse);
        edge.motions.push(motion);
      }
      edgesSvg.append(edge.group);
      edges.push(edge);
      updateEdgeGeometry(edge);
    }
  });
  fitView();
}

function placeNode(el, key) {
  const { x, y } = positions.get(key);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function renderNode(key) {
  const node = state.nodes.get(key);
  const el = nodeEls.get(key);
  if (!node || !el) return;
  el.dataset.status = node.status;
  el.classList.toggle('selected', state.selected === key);
  el.querySelector('.node-progress i').style.width = `${Math.round((node.progress || 0) * 100)}%`;
  el.querySelector('.node-meta').textContent = node.status === 'idle' ? '' : fmtDuration(elapsed(node));
}

// Un cable refleja el estado del nodo al que alimenta.
function renderEdges() {
  for (const edge of edges) {
    const status = state.nodes.get(edge.to)?.status;
    edge.group.dataset.state = { running: 'active', completed: 'done', error: 'error' }[status] ?? 'idle';
  }
}

function renderAll() {
  for (const key of state.order) renderNode(key);
  renderEdges();
  renderPipeline();
  renderDrawer();
}

// ── Pan / zoom / arrastre ────────────────────────────────────────────────────

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
  canvas.style.backgroundSize = `${24 * view.k}px ${24 * view.k}px`;
}

function zoomAt(cx, cy, factor) {
  const k = Math.min(2.5, Math.max(0.25, view.k * factor));
  view.x = cx - (cx - view.x) * (k / view.k);
  view.y = cy - (cy - view.y) * (k / view.k);
  view.k = k;
  applyView();
}

function fitView() {
  if (!positions.size) return;
  const pad = 70;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { x, y } of positions.values()) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + NODE_W); maxY = Math.max(maxY, y + NODE_H);
  }
  const { width, height } = canvas.getBoundingClientRect();
  const w = maxX - minX + pad * 2;
  const hgt = maxY - minY + pad * 2;
  view.k = Math.min(width / w, height / hgt, 1.2);
  view.x = (width - w * view.k) / 2 - (minX - pad) * view.k;
  view.y = (height - hgt * view.k) / 2 - (minY - pad) * view.k;
  applyView();
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.target.closest('.node, .canvas-tools')) return;
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('panning');
  const start = { x: event.clientX - view.x, y: event.clientY - view.y };
  const move = (e) => {
    view.x = e.clientX - start.x;
    view.y = e.clientY - start.y;
    applyView();
  };
  const up = () => {
    canvas.classList.remove('panning');
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
  };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
});

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  zoomAt(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

function zoomCenter(factor) {
  const { width, height } = canvas.getBoundingClientRect();
  zoomAt(width / 2, height / 2, factor);
}
$('#zoom-in').addEventListener('click', () => zoomCenter(1.25));
$('#zoom-out').addEventListener('click', () => zoomCenter(1 / 1.25));
$('#zoom-fit').addEventListener('click', fitView);
window.addEventListener('resize', fitView);

// Arrastrar mueve el nodo; un clic sin desplazamiento abre el drawer.
function attachNodeDrag(el, key) {
  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    el.setPointerCapture(event.pointerId);
    const origin = { ...positions.get(key) };
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;

    const move = (e) => {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      el.classList.add('dragging');
      positions.set(key, { x: origin.x + dx / view.k, y: origin.y + dy / view.k });
      placeNode(el, key);
      for (const edge of edges) if (edge.from === key || edge.to === key) updateEdgeGeometry(edge);
    };
    const up = () => {
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (!moved) selectNode(state.selected === key ? null : key);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

// ── Drawer de inspección ─────────────────────────────────────────────────────

function selectNode(key) {
  const previous = state.selected;
  state.selected = key;
  if (previous) renderNode(previous);
  if (key) renderNode(key);
  renderDrawer();
}

function renderDrawer() {
  const node = state.selected && state.nodes.get(state.selected);
  drawer.classList.toggle('open', Boolean(node));
  drawer.setAttribute('aria-hidden', String(!node));
  if (!node) {
    $('#player-video').pause();
    return;
  }

  $('#drawer-icon').textContent = node.icon;
  $('#drawer-title').textContent = node.label;
  $('#drawer-sub').textContent = `Nodo ${node.index + 1} · ${node.subtitle}`;
  const status = $('#drawer-status');
  status.textContent = node.status;
  status.dataset.status = node.status;

  const telemetry = [
    ['Estado', node.status],
    ['Progreso', `${Math.round((node.progress || 0) * 100)} %`],
    ['Inicio', fmtTime(node.startedAt)],
    ['Fin', fmtTime(node.finishedAt)],
    ['Duración', fmtDuration(elapsed(node))],
  ];
  $('#drawer-telemetry').replaceChildren(
    ...telemetry.flatMap(([label, value]) => [h('dt', { text: label }), h('dd', { text: value })]),
  );

  $('#drawer-error-section').hidden = !node.error;
  $('#drawer-error').textContent = node.error ?? '';
  $('#drawer-data').textContent = node.data ? JSON.stringify(node.data, null, 2) : 'Sin datos todavía.';

  // Galería de clips virales si el nodo tiene clips descubiertos
  const clips = node.data?.clips || (node.key === 'player' ? node.data?.clips : null);
  const clipsSection = $('#drawer-clips-section');
  if (clipsSection) {
    if (clips && clips.length) {
      clipsSection.hidden = false;
      $('#clips-count-badge').textContent = `${clips.length} clips`;
      const list = $('#drawer-clips-list');
      list.replaceChildren(
        ...clips.map((clip, idx) => {
          const card = h('div', { class: 'clip-card' });
          const head = h('div', { class: 'clip-card-head' },
            h('span', { text: `Clip #${idx + 1}` }),
            h('span', { class: 'clip-score', text: `${clip.scorePercent || Math.round((clip.score || 0) * 100)}% viral` }),
          );
          const title = h('div', { class: 'clip-title', text: clip.title || clip.hook });
          const timeText = clip.startClock
            ? `⏱ ${clip.startClock} → ${clip.endClock} (${clip.durationSec.toFixed(1)}s)`
            : `⏱ ${clip.startSec.toFixed(1)}s → ${clip.endSec.toFixed(1)}s (${clip.durationSec.toFixed(1)}s)`;
          const time = h('div', { class: 'clip-time', text: timeText });
          const btn = h('button', { class: 'clip-btn', type: 'button', text: '▶ Renderizar este clip' });
          btn.addEventListener('click', () => {
            fetch('/api/pipeline/start', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: state.pipeline.url,
                options: { start: clip.startSec, end: clip.endSec },
              }),
            }).catch((err) => alert(err.message));
          });
          card.append(head, title, time, btn);
          return card;
        }),
      );
    } else {
      clipsSection.hidden = true;
    }
  }

  const nodeLogs = state.logs.filter((entry) => entry.node === node.key).slice(-60);
  $('#drawer-logs').replaceChildren(...nodeLogs.map((entry) => logLine(entry, false)));

  renderPlayer(node.key === 'player');
}

// El <video> se conserva entre renders para no interrumpir la reproducción.
function renderPlayer(visible) {
  const video = $('#player-video');
  const download = $('#player-download');
  const videoUrl = state.pipeline.output?.videoUrl ?? null;
  $('#drawer-player').hidden = !visible;
  if (!visible) {
    video.pause();
    return;
  }
  if (videoUrl && video.getAttribute('src') !== videoUrl) {
    video.src = videoUrl;
    download.href = videoUrl;
    download.setAttribute('download', state.pipeline.output.fileName ?? 'reel.mp4');
  } else if (!videoUrl && video.hasAttribute('src')) {
    video.removeAttribute('src');
    video.load();
  }
  video.hidden = !videoUrl;
  download.hidden = !videoUrl;
  $('#player-empty').hidden = Boolean(videoUrl);
}

$('#drawer-close').addEventListener('click', () => selectNode(null));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') selectNode(null);
});

// ── Logs ─────────────────────────────────────────────────────────────────────

function logLine(entry, withNode = true) {
  const line = h('div', { class: 'log-line', 'data-level': entry.level },
    h('span', { class: 'log-time', text: fmtTime(entry.ts) }),
  );
  if (withNode) line.append(h('span', { class: 'log-node', text: entry.node ?? 'pipeline' }));
  line.append(h('span', { class: 'log-msg', text: entry.message }));
  return line;
}

function appendLog(entry) {
  logList.append(logLine(entry));
  while (logList.childElementCount > MAX_LOG_LINES) logList.firstElementChild.remove();
  $('#log-count').textContent = String(logList.childElementCount);
  if ($('#log-autoscroll').checked) logList.scrollTop = logList.scrollHeight;
}

function resetLogs(entries) {
  logList.replaceChildren();
  $('#log-count').textContent = '0';
  entries.forEach(appendLog);
}

$('#log-clear').addEventListener('click', () => resetLogs([]));

// ── Pipeline / formulario ────────────────────────────────────────────────────

function renderPipeline() {
  const { status } = state.pipeline;
  const chip = $('#pipeline-chip');
  chip.textContent = status;
  chip.dataset.status = status;
  $('#start-btn').disabled = status === 'running';
  $('#start-btn').textContent = status === 'running' ? '⏳ Procesando…' : '▶ Generar clip';
}

function showFormError(message) {
  const box = $('#form-error');
  box.textContent = message ?? '';
  box.hidden = !message;
}

$('#start-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showFormError(null);
  const url = $('#url-input').value.trim();
  if (!url) return;
  try {
    const res = await fetch('/api/pipeline/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, options: {} }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showFormError(body.error ?? `Error ${res.status} al iniciar el pipeline.`);
    }
  } catch {
    showFormError('No se pudo contactar al servidor.');
  }
});

// ── SSE ──────────────────────────────────────────────────────────────────────

function connect() {
  const source = new EventSource('/api/pipeline/stream');
  const chip = $('#sse-chip');

  source.onopen = () => { chip.dataset.conn = 'on'; };
  source.onerror = () => { chip.dataset.conn = 'off'; }; // EventSource reconecta solo.

  source.addEventListener('snapshot', (event) => {
    const snap = JSON.parse(event.data);
    state.pipeline = snap.pipeline;
    state.order = snap.nodes.map((node) => node.key);
    state.nodes = new Map(snap.nodes.map((node) => [node.key, node]));
    state.logs = snap.logs;
    if (!nodeEls.size) buildGraph(snap.nodes);
    resetLogs(snap.logs);
    renderAll();
  });

  source.addEventListener('node', (event) => {
    const node = JSON.parse(event.data);
    state.nodes.set(node.key, node);
    renderNode(node.key);
    renderEdges();
    if (state.selected === node.key) renderDrawer();
  });

  source.addEventListener('log', (event) => {
    const entry = JSON.parse(event.data);
    state.logs.push(entry);
    if (state.logs.length > MAX_LOG_LINES) state.logs.shift();
    appendLog(entry);
    if (entry.node && state.selected === entry.node) renderDrawer();
  });

  source.addEventListener('pipeline', (event) => {
    state.pipeline = JSON.parse(event.data);
    renderPipeline();
    if (state.pipeline.status === 'completed' && state.pipeline.output?.videoUrl) selectNode('player');
    else renderDrawer();
  });
}

// Cronómetro en vivo de los nodos en ejecución.
setInterval(() => {
  for (const node of state.nodes.values()) {
    if (node.status !== 'running') continue;
    renderNode(node.key);
    if (state.selected === node.key) renderDrawer();
  }
}, 100);

applyView();
connect();
