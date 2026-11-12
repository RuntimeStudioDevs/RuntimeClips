// RuntimeClips — servidor local: API REST + SSE para el grafo en árbol observable.
//
//   GET  /api/pipeline/stream  → Server-Sent Events (snapshot, node, log, pipeline, graph_expanded)
//   POST /api/pipeline/start   → { url, options } inicia una ejecución en árbol
//   GET  /api/pipeline/status  → estado actual del pipeline, nodos, aristas y logs

import express from 'express';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TRUNK_NODES, JOIN_NODES, runPipeline } from './src/pipeline/orchestrator.mjs';
import { listBrands } from './src/pipeline/brand.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// Solo loopback: el estudio es 100% local y privado.
const HOST = process.env.HOST || '127.0.0.1';
const RENDERS_DIR = path.join(__dirname, 'renders');
const MAX_LOGS = 500;

mkdirSync(RENDERS_DIR, { recursive: true });

// ── Estado en memoria ────────────────────────────────────────────────────────

const TRUNK_EDGES = [
  { from: 'input', to: 'ingest' },
  { from: 'ingest', to: 'transcribe' },
  { from: 'transcribe', to: 'hook' },
];

const freshNodes = () =>
  TRUNK_NODES.map((node, index) => ({
    ...node,
    index,
    status: 'idle',
    progress: 0,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    data: null,
    error: null,
  }));

const pipeline = {
  runId: null,
  status: 'idle', // idle | running | completed | error
  url: null,
  sourceType: null,
  options: {},
  startedAt: null,
  finishedAt: null,
  error: null,
  output: null,
};

let nodes = freshNodes();
let edges = [...TRUNK_EDGES];
let logs = [];
let logSeq = 0;

const snapshot = () => ({ pipeline, nodes, edges, logs });

// ── SSE ──────────────────────────────────────────────────────────────────────

const clients = new Set();

const frame = (event, payload) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

function broadcast(event, payload) {
  const data = frame(event, payload);
  for (const res of clients) res.write(data);
}

const emit = {
  expandGraph({ trunkNodes, branchNodes, joinNodes, edges: newEdges, totalBranches }) {
    const combined = [...trunkNodes, ...branchNodes, ...joinNodes].map((n, i) => {
      const existing = nodes.find((x) => x.key === n.key);
      return existing || {
        ...n,
        index: i,
        status: 'idle',
        progress: 0,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        data: null,
        error: null,
      };
    });
    nodes = combined;
    edges = newEdges;
    broadcast('graph_expanded', { nodes, edges, totalBranches });
    broadcast('snapshot', snapshot());
  },
  node(key, patch) {
    const node = nodes.find((n) => n.key === key);
    if (!node) return;
    Object.assign(node, patch);
    broadcast('node', node);
  },
  log(level, message, nodeKey = null) {
    const entry = { id: ++logSeq, ts: Date.now(), level, node: nodeKey, message };
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.shift();
    broadcast('log', entry);
  },
  pipeline(patch) {
    Object.assign(pipeline, patch);
    broadcast('pipeline', pipeline);
  },
};

// ── Ejecución ────────────────────────────────────────────────────────────────

// Devuelve el tipo de origen o null si no es una URL http(s) ni un archivo local existente.
function classifySource(input) {
  try {
    const { protocol, hostname } = new URL(input);
    if (protocol === 'http:' || protocol === 'https:') {
      return /(^|\.)(youtube\.com|youtu\.be)$/i.test(hostname) ? 'youtube' : 'url';
    }
  } catch {
    // No es una URL: se evalúa como ruta local.
  }
  return existsSync(input) ? 'local' : null;
}

async function startRun(url, sourceType, options) {
  nodes = freshNodes();
  edges = [...TRUNK_EDGES];
  logs = [];
  Object.assign(pipeline, {
    runId: Date.now().toString(36),
    status: 'running',
    url,
    sourceType,
    options,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    output: null,
  });
  broadcast('snapshot', snapshot());
  emit.log('info', `Pipeline ${pipeline.runId} iniciado → ${url}`);

  try {
    const output = await runPipeline({ ...pipeline, rendersDir: RENDERS_DIR }, emit);
    emit.pipeline({ status: 'completed', finishedAt: Date.now(), output });
    emit.log('success', `Pipeline completado en ${pipeline.finishedAt - pipeline.startedAt} ms`);
  } catch (err) {
    emit.pipeline({ status: 'error', finishedAt: Date.now(), error: err.message });
    emit.log('error', `Pipeline detenido: ${err.message}`);
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.get('/api/pipeline/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  res.write(frame('snapshot', snapshot()));
  clients.add(res);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

app.post('/api/pipeline/start', (req, res) => {
  const { url, options = {} } = req.body ?? {};
  if (typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'Se requiere "url" (URL de YouTube o ruta local de video).' });
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    return res.status(400).json({ error: '"options" debe ser un objeto.' });
  }
  if (pipeline.status === 'running') {
    return res.status(409).json({ error: 'Ya hay un pipeline en ejecución.', runId: pipeline.runId });
  }
  const source = url.trim();
  const sourceType = classifySource(source);
  if (!sourceType) {
    return res.status(400).json({ error: 'El origen no es una URL http(s) válida ni un archivo local existente.' });
  }

  startRun(source, sourceType, options);
  res.status(202).json({ runId: pipeline.runId, status: pipeline.status });
});

app.get('/api/pipeline/status', (_req, res) => {
  res.json({ ...snapshot(), clients: clients.size });
});

app.get('/api/brands', (_req, res) => {
  res.json({ brands: listBrands() });
});

app.use('/renders', express.static(RENDERS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: status === 400 ? 'JSON inválido.' : 'Error interno del servidor.' });
});

app.listen(PORT, HOST, () => {
  console.log(`RuntimeClips dashboard → http://localhost:${PORT}`);
});
