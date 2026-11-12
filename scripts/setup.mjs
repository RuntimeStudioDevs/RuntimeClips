// npm run setup
//
// Una sola vez por máquina: comprueba las herramientas y descarga lo que el
// pipeline necesita para trabajar sin conexión (Chrome headless para el render,
// el modelo de transcripción Parakeet y el detector de caras). Solo descarga;
// no sube nada.
import { findTool, hf, HF_VERSION } from '../src/pipeline/tools.mjs';
import { ensureFaceModel } from '../src/pipeline/reframe.mjs';

const ok = (label, detail) => console.log(`  ✓ ${label.padEnd(16)} ${detail}`);
const bad = (label, detail) => console.log(`  ✗ ${label.padEnd(16)} ${detail}`);
let missing = 0;

console.log('\nHerramientas');
if (Number(process.versions.node.split('.')[0]) >= 22) ok('Node.js', process.version);
else {
  bad('Node.js', `${process.version} (se requiere 22+)`);
  missing++;
}
const INSTALL = {
  ffmpeg: 'winget install Gyan.FFmpeg',
  ffprobe: 'winget install Gyan.FFmpeg',
  'yt-dlp': 'winget install yt-dlp.yt-dlp',
  deno: 'winget install DenoLand.Deno   (lo usa yt-dlp para YouTube)',
};
for (const [name, hint] of Object.entries(INSTALL)) {
  const found = findTool(name);
  if (found) ok(name, found);
  else {
    bad(name, `no encontrado → ${hint}`);
    missing++;
  }
}
if (missing) {
  console.log('\nInstala lo que falta, abre una terminal nueva y vuelve a correr: npm run setup');
  process.exit(1);
}

console.log(`\nHyperFrames ${HF_VERSION}`);
const step = async (label, args) => {
  const lines = [];
  const res = await hf(args, { allowFail: true, onStdout: (line) => lines.push(line), onStderr: (line) => lines.push(line) });
  if (res.code === 0) ok(label, 'listo');
  else {
    bad(label, lines.slice(-2).join(' ').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').slice(0, 200));
    missing++;
  }
};
await step('Chrome headless', ['browser', 'ensure']);
await step('Modelo Parakeet', ['models', 'install', 'parakeet']);

console.log('\nDetector de caras');
try {
  ok('UltraFace', await ensureFaceModel());
} catch (err) {
  bad('UltraFace', `${err.message} (el reencuadre usará recorte centrado)`);
}

console.log(missing ? '\nQuedaron pasos pendientes: revisa los ✗ de arriba.' : '\nTodo listo. Arranca el estudio con: npm start  →  http://localhost:3000');
process.exit(missing ? 1 : 0);
