#!/usr/bin/env node
// CLI para Agentes de IA: Paso 1 — Ingesta, transcripción y detección de clips candidatos.
// Salida en formato JSON estructurado a stdout.

import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { ROOT } from '../pipeline/tools.mjs';
import { ingest } from '../pipeline/downloader.mjs';
import { transcribe } from '../pipeline/transcriber.mjs';
import { detectHook } from '../pipeline/hook_detector.mjs';

async function main() {
  const args = process.argv.slice(2);
  let url = null;
  let minScore = 0.40;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) url = args[++i];
    else if (args[i] === '--minScore' && args[i + 1]) minScore = Number(args[++i]);
    else if (!args[i].startsWith('--')) url ??= args[i];
  }

  if (!url) {
    console.error(JSON.stringify({ error: 'Se requiere --url <enlace de YouTube o archivo local>' }));
    process.exit(1);
  }

  const isUrl = /^https?:\/\//i.test(url);
  const sourceType = isUrl ? (/(youtube\.com|youtu\.be)/i.test(url) ? 'youtube' : 'url') : 'local';

  if (!isUrl && !existsSync(url)) {
    console.error(JSON.stringify({ error: `Archivo local no encontrado: ${url}` }));
    process.exit(1);
  }

  const runId = Date.now().toString(36);
  const projectDir = path.join(ROOT, 'projects', runId);
  mkdirSync(projectDir, { recursive: true });

  const log = (_lvl, msg) => process.stderr.write(`[ANALYZE] ${msg}\n`);

  try {
    // 1. Ingest
    log('info', `Ingiriendo origen (${sourceType}): ${url}`);
    const media = await ingest({ url, sourceType, projectDir, options: {} }, { log });

    // 2. Transcribe
    log('info', `Transcribiendo audio de ${(media.durationSec / 60).toFixed(1)} min…`);
    const transcript = await transcribe({ audio: media.audio, projectDir, durationSec: media.durationSec, options: {} }, { log });

    // 3. Hook Detection
    log('info', `Detectando clips virales con score >= ${minScore}…`);
    const hookResult = detectHook({
      words: transcript.words,
      sentences: transcript.sentences,
      durationSec: media.durationSec,
      options: { minScore },
    }, { log });

    const result = {
      runId,
      projectDir,
      media: {
        title: media.meta.title ?? null,
        durationSec: media.durationSec,
        durationMinutes: Number((media.durationSec / 60).toFixed(1)),
      },
      transcript: {
        totalWords: transcript.words.length,
        totalSentences: transcript.sentences.length,
      },
      hooks: {
        totalDiscovered: hookResult.clips.length,
        theoreticalMax: hookResult.theoreticalMax,
        coveragePercent: hookResult.coveragePercent,
        clips: hookResult.clips,
      },
    };

    // Imprimir resultado JSON limpio a stdout
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message, stack: err.stack }));
    process.exit(1);
  }
}

main();
