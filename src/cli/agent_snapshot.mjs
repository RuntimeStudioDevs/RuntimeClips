#!/usr/bin/env node
// CLI para Agentes de IA: Generador de Contact Sheets y Fotogramas para inspección multimodal.
// Salida en formato JSON estructurado a stdout.

import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { ROOT } from '../pipeline/tools.mjs';
import { generateContactSheet } from '../pipeline/snapshot.mjs';

async function main() {
  const args = process.argv.slice(2);
  let target = null;
  let outDir = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) target = args[++i];
    else if (args[i] === '--runId' && args[i + 1]) target = args[++i];
    else if (args[i] === '--outDir' && args[i + 1]) outDir = args[++i];
    else if (!args[i].startsWith('--')) target ??= args[i];
  }

  if (!target) {
    console.error(JSON.stringify({ error: 'Uso: node src/cli/agent_snapshot.mjs [--file <ruta.mp4> | --runId <id>] [--outDir <dir>]' }));
    process.exit(1);
  }

  let files = [];
  if (target.endsWith('.mp4') && existsSync(target)) {
    files.push(target);
  } else {
    const rendersDir = path.join(ROOT, 'renders');
    if (existsSync(rendersDir)) {
      const matched = readdirSync(rendersDir)
        .filter((f) => f.includes(target) && f.endsWith('.mp4'))
        .map((f) => path.join(rendersDir, f));
      files.push(...matched);
    }
  }

  if (!files.length) {
    console.error(JSON.stringify({ error: `No se encontraron archivos MP4 para ${target}` }));
    process.exit(1);
  }

  try {
    const results = [];
    for (const file of files) {
      const res = await generateContactSheet(file, outDir, {
        log: (_lvl, msg) => process.stderr.write(`[SNAPSHOT] ${msg}\n`),
      });
      results.push({
        videoFile: path.basename(file),
        ...res,
      });
    }

    console.log(JSON.stringify({ total: results.length, snapshots: results }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
