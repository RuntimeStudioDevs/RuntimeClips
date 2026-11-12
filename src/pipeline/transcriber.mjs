// Nodo 3 — Local Transcribe.
//
// Transcripción palabra por palabra en local con el CLI de HyperFrames:
// Parakeet TDT (sherpa-onnx) si el modelo está instalado y, si no, Whisper.
// El audio nunca sale de la máquina.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hf } from './tools.mjs';

const STOPWORDS = {
  es: new Set('de la que el en y a los se del las un por con no una su para es al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mi mis tú te ti tu tus'.split(' ')),
  en: new Set('the of and to in is that it was for on are as with his they at be this from have or by one had not but what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know'.split(' ')),
};

// Parakeet v3 es multilingüe y, en español, a veces "oye" palabras función en
// inglés ("in tan solo" por "en tan solo"). Solo se corrigen las que no dejan
// dudas, y solo cuando el idioma pedido es español y el texto lo confirma.
const ES_FIXES = new Map(Object.entries({
  in: 'en', and: 'y', that: 'que', when: 'cuando', of: 'de', with: 'con', but: 'pero',
  is: 'es', for: 'para', from: 'de', not: 'no', because: 'porque', what: 'qué', where: 'donde',
}));

const bare = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Idioma dominante por proporción de palabras función. */
export function detectLanguage(words) {
  const hits = { es: 0, en: 0 };
  for (const w of words) {
    const token = bare(w.text);
    if (STOPWORDS.es.has(token)) hits.es++;
    if (STOPWORDS.en.has(token)) hits.en++;
  }
  if (hits.es + hits.en < 8) return null;
  return hits.es >= hits.en ? 'es' : 'en';
}

function fixSpanish(words) {
  let fixed = 0;
  const out = words.map((w) => {
    const match = /^([^\p{L}]*)(\p{L}+)([^\p{L}]*)$/u.exec(w.text);
    const replacement = match && ES_FIXES.get(match[2].toLowerCase());
    if (!replacement) return w;
    fixed++;
    const upper = match[2][0] !== match[2][0].toLowerCase();
    const word = upper ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
    return { ...w, text: match[1] + word + match[3] };
  });
  return { words: out, fixed };
}

function normalizeWords(raw) {
  const list = Array.isArray(raw) ? raw : raw.words ?? (raw.segments ?? []).flatMap((s) => s.words ?? []);
  return list
    .map((w) => ({ text: String(w.text ?? w.word ?? '').trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start)
    .sort((a, b) => a.start - b.start);
}

const SENTENCE_END = /[.!?…]["'”»)]*$/;
const SENTENCE_PAUSE = 0.7; // un silencio así de largo también cierra la frase

/** Agrupa las palabras en frases por puntuación fuerte o silencios. */
export function toSentences(words) {
  const sentences = [];
  let first = 0;
  words.forEach((word, i) => {
    const next = words[i + 1];
    if (!next || SENTENCE_END.test(word.text) || next.start - word.end >= SENTENCE_PAUSE) {
      sentences.push({
        firstWord: first,
        lastWord: i,
        start: words[first].start,
        end: word.end,
        text: words.slice(first, i + 1).map((w) => w.text).join(' '),
      });
      first = i + 1;
    }
  });
  return sentences;
}

/**
 * @param {{ audio: string, projectDir: string, durationSec: number, options?: object }} input
 * @returns {Promise<{ engine, model, language, words, sentences, transcriptPath }>}
 */
export async function transcribe({ audio, projectDir, durationSec, options = {} }, { log, onProgress }) {
  const language = typeof options.lang === 'string' ? options.lang : 'es';
  const engine = ['parakeet', 'whisper'].includes(options.engine) ? options.engine : 'auto';
  const transcriptPath = path.join(projectDir, 'transcript.json');

  log('info', `Transcribiendo en local (motor: ${engine}, idioma: ${language})`);
  let summary = null;
  let wordsSoFar = 0;
  const { code, stderr } = await hf(
    ['transcribe', audio, '--dir', projectDir, '--language', language, '--engine', engine,
      ...(typeof options.whisperModel === 'string' ? ['--model', options.whisperModel] : []), '--json'],
    {
      cwd: projectDir,
      allowFail: true,
      onStdout: (line) => {
        try {
          summary = JSON.parse(line);
        } catch {
          // Solo interesa la línea JSON final.
        }
      },
      // El progreso llega por stderr como JSON por línea: lotes de palabras con sus tiempos.
      onStderr: (line) => {
        if (line[0] !== '{') return;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === 'progress' && event.status === 'started') {
          log('info', `Modelo ${event.model} cargado: decodificando ${Math.round(event.durationSeconds ?? durationSec)} s de audio`);
        } else if (event.type === 'words' && event.words?.length) {
          wordsSoFar += event.words.length;
          const at = event.words[event.words.length - 1].end;
          onProgress(Math.min(0.95, at / durationSec));
          log('info', `${event.model ?? 'ASR'}: ${wordsSoFar} palabras · ${at.toFixed(0)} / ${durationSec.toFixed(0)} s`);
        }
      },
    },
  );

  if (code !== 0 || !summary?.ok || !existsSync(transcriptPath)) {
    const reason = summary?.reason ?? stderr.split('\n').filter((l) => l[0] !== '{').slice(-3).join(' | ');
    throw new Error(
      `La transcripción local falló (${reason || `código ${code}`}). ` +
        'Instala el modelo con "npm run setup" (npx hyperframes models install parakeet).',
    );
  }

  let words = normalizeWords(JSON.parse(readFileSync(transcriptPath, 'utf8')));
  if (!words.length) throw new Error('La transcripción no devolvió palabras: el video no tiene voz reconocible.');

  const detected = detectLanguage(words);
  let fixed = 0;
  if (language === 'es' && detected === 'es' && options.fixLanguage !== false) {
    writeFileSync(path.join(projectDir, 'transcript.raw.json'), JSON.stringify(words));
    ({ words, fixed } = fixSpanish(words));
    if (fixed) log('info', `Corregidas ${fixed} palabras función que el modelo dejó en inglés (original en transcript.raw.json)`);
  }
  if (detected && detected !== language) log('warn', `El audio parece estar en "${detected}" y se pidió "${language}"`);

  writeFileSync(transcriptPath, `${JSON.stringify(words.map((w, i) => ({ id: `w${i}`, ...w })), null, 2)}\n`);
  const sentences = toSentences(words);
  log('info', `Marcas de tiempo por palabra listas: ${words.length} palabras en ${sentences.length} frases`);

  return {
    engine: summary.engine,
    model: summary.model,
    language: detected ?? language,
    words,
    sentences,
    fixedWords: fixed,
    transcriptPath,
  };
}
