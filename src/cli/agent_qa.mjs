#!/usr/bin/env node
// CLI para Agentes de IA: Paso 4 — Auditoría de QA técnica y gatekeeper.
// Salida en formato JSON estructurado a stdout.

import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { ROOT } from '../pipeline/tools.mjs';
import { auditClip } from '../pipeline/qa_auditor.mjs';

async function main() {
  const args = process.argv.slice(2);
  let target = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) target = args[++i];
    else if (args[i] === '--runId' && args[i + 1]) target = args[++i];
    else if (!args[i].startsWith('--')) target ??= args[i];
  }

  if (!target) {
    console.error(JSON.stringify({ error: 'Uso: node src/cli/agent_qa.mjs [--file <ruta.mp4> | --runId <id>]' }));
    process.exit(1);
  }

  // Si es un runId, buscar videos de esa ejecución en renders/
  let filesToAudit = [];
  if (target.endsWith('.mp4') && existsSync(target)) {
    filesToAudit.push(target);
  } else {
    const rendersDir = path.join(ROOT, 'renders');
    if (existsSync(rendersDir)) {
      const matched = readdirSync(rendersDir)
        .filter((f) => f.includes(target) && f.endsWith('.mp4'))
        .map((f) => path.join(rendersDir, f));
      filesToAudit.push(...matched);
    }
    if (!filesToAudit.length && existsSync(target)) {
      filesToAudit.push(target);
    }
  }

  if (!filesToAudit.length) {
    console.error(JSON.stringify({ error: `No se encontraron archivos MP4 para auditar correspondientes a: ${target}` }));
    process.exit(1);
  }

  try {
    const reports = [];
    for (const file of filesToAudit) {
      const report = await auditClip(file, {
        log: (_lvl, msg) => process.stderr.write(`[QA] ${msg}\n`),
      });
      reports.push(report);
    }

    const allPassed = reports.every((r) => r.pass);
    const summary = {
      totalAudited: reports.length,
      verdict: allPassed ? 'LISTO' : 'BLOQUEA',
      pass: allPassed,
      reports,
    };

    console.log(JSON.stringify(summary, null, 2));
    process.exit(allPassed ? 0 : 2);
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
