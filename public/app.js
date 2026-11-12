// RuntimeClips — dashboard en árbol: grafo dinámico Fork/Join, cables animados, logs SSE, drawer y reproductor multi-clip.

const NODE_W = 220;
const NODE_H = 84;
const MAX_LOG_LINES = 500;
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (selector) => document.querySelector(selector);

const state = {
  pipeline: { status: 'idle', output: null },
  nodes: new Map(), // key → nodo
  order: [],
  edgesData: [],
  logs: [],
  selected: null,
  activePreviewClip: null,
};

const view = { x: 0, y: 0, k: 1 };
const positions = new Map(); // key → { x, y }
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

// ── Auto-Layout de Grafo en Árbol (DAG) ───────────────────────────────────────

function calculateTreePositions(nodesList) {
  positions.clear();
  // Identificar ramas por branchId
  const branches = [...new Set(nodesList.filter((n) => n.branchId).map((n) => n.branchId))];
  const branchCount = branches.length;
  const rowHeight = 110;
  const centerY = branchCount > 0 ? 60 + ((branchCount - 1) * rowHeight) / 2 : 140;

  // Tronco inicial
  const trunkX = { input: 40, ingest: 310, transcribe: 580, hook: 850 };
  const joinX = { collector: 2240, player: 2520 };

  nodesList.forEach((node, index) => {
    if (trunkX[node.key] !== undefined) {
      positions.set(node.key, { x: trunkX[node.key], y: centerY });
    } else if (joinX[node.key] !== undefined) {
      positions.set(node.key, { x: joinX[node.key], y: centerY });
    } else if (node.branchId) {
      const branchIdx = branches.indexOf(node.branchId);
      const rowY = 60 + branchIdx * rowHeight;
      if (node.key.startsWith('reframe-')) positions.set(node.key, { x: 1140, y: rowY });
      else if (node.key.startsWith('overlays-')) positions.set(node.key, { x: 1410, y: rowY });
      else if (node.key.startsWith('captions-')) positions.set(node.key, { x: 1680, y: rowY });
      else if (node.key.startsWith('render-')) positions.set(node.key, { x: 1950, y: rowY });
      else positions.set(node.key, { x: 1140 + (index % 4) * 270, y: rowY });
    } else {
      positions.set(node.key, { x: 40 + index * 270, y: centerY });
    }
  });
}

function edgePath(from, to) {
  const a = positions.get(from);
  const b = positions.get(to);
  if (!a || !b) return '';
  const sx = a.x + NODE_W;
  const sy = a.y + NODE_H / 2;
  const tx = b.x;
  const ty = b.y + NODE_H / 2;
  const dx = tx - sx;
  const bend = dx >= 0 ? Math.max(45, dx / 2) : 80;
  return `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`;
}

function updateEdgeGeometry(edge) {
  const d = edgePath(edge.from, edge.to);
  edge.path.setAttribute('d', d);
  for (const motion of edge.motions) motion.setAttribute('path', d);
}

function buildGraph(nodesList, edgesList = []) {
  // Limpiar elementos previos
  nodeEls.forEach((el) => el.remove());
  nodeEls.clear();
  edgesSvg.replaceChildren();
  edges.length = 0;

  calculateTreePositions(nodesList);

  nodesList.forEach((node, index) => {
    const el = h('div', { class: 'node', 'data-key': node.key, 'data-status': node.status || 'idle' },
      h('span', { class: 'port in' }),
      h('div', { class: 'node-icon', text: node.icon }),
      h('div', { class: 'node-body' },
        h('div', { class: 'node-idx', text: node.branchId ? `${node.branchId.toUpperCase()}` : String(index + 1).padStart(2, '0') }),
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
  });

  // Construir aristas
  edgesList.forEach((e) => {
    if (!positions.has(e.from) || !positions.has(e.to)) return;
    const edge = {
      from: e.from,
      to: e.to,
      group: svg('g', { class: 'edge-group', 'data-state': 'idle' }),
      path: svg('path', { class: 'edge' }),
      motions: [],
    };
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
  });

  fitView();
}

function placeNode(el, key) {
  const pos = positions.get(key);
  if (!pos) return;
  el.style.left = `${pos.x}px`;
  el.style.top = `${pos.y}px`;
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

function fitView() {
  const xs = [...positions.values()].map((p) => p.x);
  const ys = [...positions.values()].map((p) => p.y);
  if (!xs.length) return;
  const minX = Math.min(...xs) - 40;
  const maxX = Math.max(...xs) + NODE_W + 40;
  const minY = Math.min(...ys) - 40;
  const maxY = Math.max(...ys) + NODE_H + 40;
  const graphW = maxX - minX;
  const graphH = maxY - minY;
  const { clientWidth: w, clientHeight: h } = canvas;
  if (!w || !h) return;
  view.k = Math.max(0.3, Math.min(1.0, 0.9 * Math.min(w / graphW, h / graphH)));
  view.x = (w - graphW * view.k) / 2 - minX * view.k;
  view.y = (h - graphH * view.k) / 2 - minY * view.k;
  applyView();
}

$('#zoom-in').addEventListener('click', () => {
  view.k = Math.min(1.8, view.k * 1.2);
  applyView();
});
$('#zoom-out').addEventListener('click', () => {
  view.k = Math.max(0.25, view.k / 1.2);
  applyView();
});
$('#zoom-fit').addEventListener('click', fitView);

// Arrastre del lienzo
canvas.addEventListener('pointerdown', (event) => {
  if (event.target.closest('.node') || event.target.closest('.canvas-tools')) return;
  const start = { x: event.clientX - view.x, y: event.clientY - view.y };
  const move = (e) => {
    view.x = e.clientX - start.x;
    view.y = e.clientY - start.y;
    applyView();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// Arrastre individual de nodos
function attachNodeDrag(el, key) {
  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY };
    const origin = { ...positions.get(key) };
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
  $('#drawer-sub').textContent = node.subtitle;
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

  // Galería de clips en el nodo hook
  const clips = node.data?.clips;
  const clipsSection = $('#drawer-clips-section');
  if (clipsSection) {
    if (node.key === 'hook' && clips && clips.length) {
      clipsSection.hidden = false;
      $('#clips-count-badge').textContent = `${clips.length} clips`;
      const list = $('#drawer-clips-list');
      list.replaceChildren(
        ...clips.map((clip, idx) => {
          const card = h('div', { class: 'clip-card' });
          const head = h('div', { class: 'clip-card-head' },
            h('span', { text: `Rama #${idx + 1}` }),
            h('span', { class: 'clip-score', text: `${clip.scorePercent || Math.round((clip.score || 0) * 100)}% viral` }),
          );
          const title = h('div', { class: 'clip-title', text: clip.title || clip.hook });
          const timeText = clip.startClock
            ? `⏱ ${clip.startClock} → ${clip.endClock} (${clip.durationSec.toFixed(1)}s)`
            : `⏱ ${clip.startSec.toFixed(1)}s → ${clip.endSec.toFixed(1)}s (${clip.durationSec.toFixed(1)}s)`;
          const time = h('div', { class: 'clip-time', text: timeText });
          card.append(head, title, time);
          return card;
        }),
      );
    } else {
      clipsSection.hidden = true;
    }
  }

  const nodeLogs = state.logs.filter((entry) => entry.node === node.key).slice(-60);
  $('#drawer-logs').replaceChildren(...nodeLogs.map((entry) => logLine(entry, false)));

  renderPlayer(node.key === 'player' || node.key === 'collector');
}

// ── Multi-Player & ZIP Packager ──────────────────────────────────────────────

function renderPlayer(visible) {
  $('#drawer-player').hidden = !visible;
  if (!visible) {
    $('#player-video').pause();
    return;
  }

  const output = state.pipeline.output;
  const zipBanner = $('#zip-package-banner');
  const zipBtn = $('#player-zip-download');

  // 1. Banner de ZIP maestro
  if (output && output.zipUrl) {
    zipBanner.hidden = false;
    zipBtn.href = output.zipUrl;
    zipBtn.setAttribute('download', output.zipFile || 'clips.zip');
    zipBtn.textContent = `⬇ Descargar todos en .ZIP (${output.zipSizeMb || 0} MB)`;
    $('#zip-banner-title').textContent = `${output.totalClips || 0} Reels Generados`;
    $('#zip-banner-desc').textContent = `Paquete comprimido listo: ${output.zipFile}`;
  } else {
    zipBanner.hidden = true;
  }

  // 2. Galería de Reels generados
  const gallerySection = $('#player-gallery-section');
  const galleryList = $('#player-gallery-list');
  const clips = output?.clips || [];

  if (clips.length) {
    gallerySection.hidden = false;
    // Seleccionar por defecto el primer clip si no hay activo
    if (!state.activePreviewClip && clips[0]) state.activePreviewClip = clips[0];

    galleryList.replaceChildren(
      ...clips.map((clip, idx) => {
        const isActive = state.activePreviewClip && state.activePreviewClip.file === clip.file;
        const card = h('div', { class: `gallery-card ${isActive ? 'active' : ''}` });

        const top = h('div', { class: 'gallery-card-top' },
          h('span', { text: `Reel #${idx + 1}` }),
          h('span', { class: 'clip-score', text: `${clip.scorePercent || 90}% viral` }),
        );
        const title = h('div', { class: 'gallery-card-title', text: clip.title || clip.hook });
        const meta = h('div', { class: 'gallery-card-meta' },
          h('span', { text: `⏱ ${clip.durationSec.toFixed(1)}s · ${clip.sizeMb} MB` }),
          h('a', { class: 'gallery-dl-btn', href: clip.videoUrl, download: clip.file, text: '⬇ Descargar MP4' }),
        );

        card.addEventListener('click', (e) => {
          if (e.target.tagName === 'A') return; // dejar actuar al enlace de descarga
          state.activePreviewClip = clip;
          renderPlayer(true);
        });

        card.append(top, title, meta);
        return card;
      }),
    );
  } else {
    gallerySection.hidden = true;
  }

  // 3. Previsualizador de video HTML5
  const video = $('#player-video');
  const download = $('#player-download');
  const currentClip = state.activePreviewClip || (output?.videoUrl ? { videoUrl: output.videoUrl, file: output.fileName } : null);

  if (currentClip && currentClip.videoUrl) {
    if (video.getAttribute('src') !== currentClip.videoUrl) {
      video.src = currentClip.videoUrl;
    }
    download.href = currentClip.videoUrl;
    download.setAttribute('download', currentClip.file || 'reel.mp4');
    download.textContent = `⬇ Descargar "${currentClip.file || 'reel.mp4'}"`;
    video.hidden = false;
    download.hidden = false;
    $('#player-empty').hidden = true;
  } else {
    video.hidden = true;
    download.hidden = true;
    $('#player-empty').hidden = false;
  }
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

// ── Pipeline / Formulario ────────────────────────────────────────────────────

function renderPipeline() {
  const { status } = state.pipeline;
  const chip = $('#pipeline-chip');
  chip.textContent = status;
  chip.dataset.status = status;
  $('#start-btn').disabled = status === 'running';
  $('#start-btn').textContent = status === 'running' ? '⏳ Procesando Árbol…' : '▶ Procesar Árbol';
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
  const clipLimit = $('#clip-limit-select')?.value || 'all';
  const workers = Number($('#workers-select')?.value) || 2;
  try {
    const res = await fetch('/api/pipeline/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        options: { clipLimit, workers },
      }),
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
  source.onerror = () => { chip.dataset.conn = 'off'; };

  source.addEventListener('snapshot', (event) => {
    const snap = JSON.parse(event.data);
    state.pipeline = snap.pipeline;
    state.order = snap.nodes.map((node) => node.key);
    state.nodes = new Map(snap.nodes.map((node) => [node.key, node]));
    state.edgesData = snap.edges || [];
    state.logs = snap.logs;
    buildGraph(snap.nodes, snap.edges || []);
    resetLogs(snap.logs);
    renderAll();
  });

  source.addEventListener('graph_expanded', (event) => {
    const data = JSON.parse(event.data);
    state.order = data.nodes.map((node) => node.key);
    state.nodes = new Map(data.nodes.map((node) => [node.key, node]));
    state.edgesData = data.edges || [];
    buildGraph(data.nodes, data.edges || []);
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
    if (state.pipeline.status === 'completed' && state.pipeline.output) {
      state.activePreviewClip = state.pipeline.output.clips?.[0] || null;
      selectNode('player');
    } else {
      renderDrawer();
    }
  });
}

// Cronómetro en vivo
setInterval(() => {
  for (const node of state.nodes.values()) {
    if (node.status !== 'running') continue;
    renderNode(node.key);
    if (state.selected === node.key) renderDrawer();
  }
}, 100);

applyView();
connect();
