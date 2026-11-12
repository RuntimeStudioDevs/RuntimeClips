#!/usr/bin/env node
// CLI para Agentes de IA: Paso 5 — Generación del Paquete Social (Copies, Títulos, Hashtags).
// Salida en formato JSON estructurado a stdout.

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { ROOT } from '../pipeline/tools.mjs';
import { buildSocialPack } from '../pipeline/social_packager.mjs';

async function main() {
  const args = process.argv.slice(2);
  let runId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runId' && args[i + 1]) runId = args[++i];
    else if (!args[i].startsWith('--')) runId ??= args[i];
  }

  if (!runId) {
    console.error(JSON.stringify({ error: 'Uso: node src/cli/agent_social.mjs --runId <id>' }));
    process.exit(1);
  }

  const projectDir = path.join(ROOT, 'projects', runId);
  const hookFile = path.join(projectDir, 'hook.json');
  const transcriptFile = path.join(projectDir, 'transcript.json');

  if (!existsSync(hookFile)) {
    console.error(JSON.stringify({ error: `No se encuentra ${hookFile}` }));
    process.exit(1);
  }

  try {
    const hookData = JSON.parse(readFileSync(hookFile, 'utf8'));
    const transcriptData = existsSync(transcriptFile) ? JSON.parse(readFileSync(transcriptFile, 'utf8')) : { words: [] };
    const clips = hookData.clips || [hookData];

    const packs = [];
    for (const clip of clips) {
      const clipWords = transcriptData.words.filter(
        (w) => w.start >= clip.startSec - 0.1 && w.end <= clip.endSec + 0.1
      );
      const outFile = path.join(projectDir, `${clip.clipId}-social-pack.json`);
      const pack = buildSocialPack(clip, clipWords, {}, {}, outFile);
      packs.push(pack);
    }

    console.log(JSON.stringify({ runId, totalPacks: packs.length, packs }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
