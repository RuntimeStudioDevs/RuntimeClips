// Nodo 4 — Hook & Clip Selector.
//
// Recorre el transcript y puntúa todas las ventanas de 30-60 s que empiezan y
// terminan en límites de frase. La puntuación (0..1) combina cuatro señales:
//
//   apertura  (35 %)  fuerza del gancho en los primeros segundos
//   claves    (25 %)  densidad de palabras de impacto, cifras y énfasis
//   ritmo     (25 %)  palabras por segundo y silencios
//   cierre    (15 %)  que termine en una frase completa, con pausa después
//
// Es determinista: el mismo transcript siempre devuelve la misma ventana.

import { clamp, snap, fmtClock } from './tools.mjs';

const WEIGHTS = { opening: 0.35, keywords: 0.25, rhythm: 0.25, closure: 0.15 };
const MIN_SEC = 30;
const MAX_SEC = 60;
const IDEAL_SEC = 45;
const LEAD_IN = 0.2; // aire antes de la primera palabra
const LEAD_OUT = 0.4; // y después de la última
const OPENING_SEC = 8; // tramo que se evalúa como gancho

const set = (text) => new Set(text.split(/\s+/).filter(Boolean));

// Palabras que cargan emoción, urgencia, curiosidad o autoridad.
export const POWER = set(`
  secreto secretos error errores verdad mentira nunca siempre nadie todos jamás increíble imposible
  importante clave problema solución peligro miedo dinero éxito fracaso gratis fácil difícil rápido
  mejor peor único primera primero último nuevo descubrí descubrir aprendí cambió cambiar cambia
  vida muerte amor odio millones millón mil gente mundo historia razón truco regla hábito hábitos
  cerebro ciencia estudio demostró resulta sorpresa sorprendente realidad futuro poder libertad
  felicidad locura loco brutal impresionante enorme terrible mágico prohibido oculto
  secret mistake truth lie never always nobody everyone incredible impossible important key problem
  solution danger fear money success failure free easy hard fast best worst only first last new
  discovered learned changed life death love hate million millions thousand people world story
  reason trick rule habit brain science study proved surprising reality future power freedom crazy
`);

// Arranques que prometen algo: funcionan como gancho por sí solos.
const HOOK_STARTERS = set(`
  imagina imagínate imagínense sabías sabes mira escucha fíjate piensa cómo qué quién cuándo cuál
  resulta nadie nunca todos jamás hace hoy ayer cuando si lo el la esto
  imagine did do what how why who when nobody never everyone today here this
`);
const STRONG_STARTERS = set(`
  imagina imagínate imagínense sabías mira escucha fíjate piensa cómo qué quién cuál resulta nadie
  nunca jamás imagine what how why nobody never
`);

// Arranques que dependen de lo anterior: fuera de contexto no se entienden.
const WEAK_STARTERS = set(`
  y e o u pero entonces porque pues así además también tampoco sino aunque ósea osea bueno
  and but so because or then also well
`);

const SECOND_PERSON = set(`
  tú te ti tu tus usted ustedes vos les nos nosotros contigo you your yours we our
`);

const bare = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const hasNumber = (text) => /\d/.test(text);

function scoreOpening(words, sentences, first, prevEnd) {
  const sentence = sentences[first];
  // El gancho son los primeros segundos, aunque abarquen más de una frase.
  const opening = words.slice(sentence.firstWord, sentence.firstWord + 28).filter((w) => w.start - sentence.start <= OPENING_SEC);
  const tokens = opening.map((w) => bare(w.text));
  const reasons = [];
  let score = 0.2;

  if (opening.some((w) => /[¿?]/.test(w.text))) {
    score += 0.3;
    reasons.push('abre con una pregunta');
  }
  const number = opening.find((w) => hasNumber(w.text));
  if (number) {
    score += 0.15;
    reasons.push(`cifra en el arranque (${number.text.replace(/[.,;:]+$/, '')})`);
  }
  const power = tokens.filter((t) => POWER.has(t));
  if (power.length) {
    score += Math.min(0.25, 0.13 * power.length);
    reasons.push(`palabras de impacto al inicio (${[...new Set(power)].slice(0, 3).join(', ')})`);
  }
  if (STRONG_STARTERS.has(tokens[0])) {
    score += 0.15;
    reasons.push(`arranque directo ("${opening[0].text}…")`);
  } else if (HOOK_STARTERS.has(tokens[0])) {
    score += 0.06;
  }
  if (tokens.some((t) => SECOND_PERSON.has(t))) {
    score += 0.12;
    reasons.push('le habla directamente al espectador');
  }
  const length = sentence.lastWord - sentence.firstWord + 1;
  if (length >= 3 && length <= 16) score += 0.12;
  else if (length > 30) score -= 0.1;

  const gapBefore = prevEnd === null ? Infinity : sentence.start - prevEnd;
  // Tras un silencio (o al inicio) la idea arranca de cero: se entiende sin contexto.
  if (prevEnd === null) {
    score += 0.2;
    reasons.push('es el inicio del discurso: se entiende sin contexto');
  } else if (gapBefore >= 0.6) {
    score += gapBefore >= 1.5 ? 0.15 : 0.08;
    reasons.push(`entra tras una pausa de ${gapBefore.toFixed(1)} s`);
  }
  if (WEAK_STARTERS.has(tokens[0])) {
    score -= 0.35;
    reasons.push(`⚠ empieza con un conector ("${opening[0].text}")`);
  }
  const firstChar = opening[0].text.replace(/^[^\p{L}\p{N}]+/u, '')[0] ?? '';
  if (firstChar && firstChar === firstChar.toLowerCase() && firstChar !== firstChar.toUpperCase()) score -= 0.15;

  return { score: clamp(score, 0, 1), reasons };
}

function scoreKeywords(slice) {
  let hits = 0;
  const found = new Set();
  for (const w of slice) {
    const token = bare(w.text);
    if (POWER.has(token)) {
      hits++;
      found.add(token);
    }
    if (hasNumber(w.text)) hits++;
    if (/[!?]/.test(w.text)) hits += 0.5;
  }
  // Un 7 % de palabras con carga ya es un tramo denso.
  const score = clamp(hits / (slice.length * 0.07), 0, 1);
  const reasons = found.size ? [`${Math.round(hits)} señales de impacto (${[...found].slice(0, 4).join(', ')})`] : [];
  return { score, reasons };
}

function scoreRhythm(slice, durationSec) {
  const wps = slice.length / durationSec;
  // Meseta de 2.2 a 3.4 palabras/s; cae a 0 en 1.0 (lento) y 4.6 (atropellado).
  const pace = wps < 2.2 ? clamp((wps - 1) / 1.2, 0, 1) : wps > 3.4 ? clamp((4.6 - wps) / 1.2, 0, 1) : 1;
  let silence = 0;
  let longest = 0;
  for (let i = 1; i < slice.length; i++) {
    const gap = slice[i].start - slice[i - 1].end;
    if (gap > 0.35) silence += gap;
    if (gap > longest) longest = gap;
  }
  const silenceRatio = silence / durationSec;
  const score = clamp(pace * 0.6 + (1 - clamp(silenceRatio / 0.25, 0, 1)) * 0.4 - (longest > 2.5 ? 0.2 : 0), 0, 1);
  const reasons = [`ritmo de ${wps.toFixed(1)} palabras/s con ${Math.round(silenceRatio * 100)} % de silencio`];
  if (longest > 2.5) reasons.push(`⚠ incluye un silencio de ${longest.toFixed(1)} s`);
  return { score, reasons, wps: Number(wps.toFixed(2)), silenceRatio: Number(silenceRatio.toFixed(3)) };
}

function scoreClosure(sentences, last, nextStart, durationSec) {
  const sentence = sentences[last];
  const reasons = [];
  let score = 0.1;
  if (/[.!?…]["'”»)]*$/.test(sentence.text)) {
    score += 0.5;
    reasons.push('cierra en final de frase');
  }
  const gapAfter = nextStart === null ? Infinity : nextStart - sentence.end;
  if (gapAfter >= 0.5) {
    score += 0.2;
    if (nextStart !== null) reasons.push(`pausa de ${gapAfter.toFixed(1)} s después`);
  }
  if (sentence.lastWord - sentence.firstWord + 1 >= 4) score += 0.1;
  score += 0.1 * (1 - Math.abs(durationSec - IDEAL_SEC) / (MAX_SEC - MIN_SEC));
  return { score: clamp(score, 0, 1), reasons };
}

function buildWindow(words, sentences, first, last, totalSec) {
  const firstWord = sentences[first].firstWord;
  const lastWord = sentences[last].lastWord;
  const prevEnd = firstWord > 0 ? words[firstWord - 1].end : 0;
  const nextStart = lastWord < words.length - 1 ? words[lastWord + 1].start : totalSec;
  // El aire de entrada y salida nunca pisa la palabra vecina.
  const startSec = snap(Math.max(prevEnd, words[firstWord].start - LEAD_IN, 0));
  const endSec = snap(Math.min(Math.max(words[lastWord].end + 0.05, nextStart - 0.02), words[lastWord].end + LEAD_OUT, totalSec));
  return { startSec, endSec, durationSec: Number((endSec - startSec).toFixed(3)), firstWord, lastWord };
}

const overlap = (a, b) => {
  const inter = Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec);
  return inter <= 0 ? 0 : inter / Math.min(a.durationSec, b.durationSec);
};

/**
 * @param {{ words: Array, sentences: Array, durationSec: number, options?: object }} input
 * @returns ventana elegida `{ startSec, endSec, durationSec, score, hook, reasons, breakdown }`
 *   más `candidates` (las mejores alternativas) y `evaluated`.
 */
export function detectHook({ words, sentences, durationSec: totalSec, options = {} }, { log = () => {} } = {}) {
  const minSec = Number(options.minSec) || MIN_SEC;
  const maxSec = Math.max(minSec, Number(options.maxSec) || MAX_SEC);

  // Ventana manual: se respeta tal cual, ajustada a la duración del video.
  const given = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  if (given(options.start) && given(options.end)) {
    const startSec = snap(clamp(Number(options.start), 0, totalSec));
    const endSec = snap(clamp(Number(options.end), startSec + 1, totalSec));
    const inside = words.filter((w) => w.start >= startSec && w.end <= endSec);
    log('info', `Ventana manual ${startSec}–${endSec} s (${inside.length} palabras)`);
    return {
      startSec, endSec, durationSec: Number((endSec - startSec).toFixed(3)),
      score: null, hook: inside.slice(0, 12).map((w) => w.text).join(' '),
      reasons: ['ventana fijada a mano (options.start / options.end)'], breakdown: null, candidates: [], evaluated: 0,
    };
  }

  const speechSec = words[words.length - 1].end - words[0].start;
  if (speechSec < minSec) {
    // Video corto: se usa todo el discurso.
    const window = buildWindow(words, sentences, 0, sentences.length - 1, totalSec);
    log('warn', `Solo hay ${speechSec.toFixed(1)} s de voz (< ${minSec} s): se usa el discurso completo`);
    return {
      ...window, score: null, hook: sentences[0].text,
      reasons: [`el video tiene menos de ${minSec} s de voz: se usa completo`], breakdown: null, candidates: [], evaluated: 1,
    };
  }

  const candidates = [];
  for (let first = 0; first < sentences.length; first++) {
    const prevEnd = first > 0 ? sentences[first - 1].end : null;
    let opening = null;
    for (let last = first; last < sentences.length; last++) {
      const window = buildWindow(words, sentences, first, last, totalSec);
      if (window.durationSec > maxSec) break;
      if (window.durationSec < minSec) continue;
      opening ??= scoreOpening(words, sentences, first, prevEnd);
      const slice = words.slice(window.firstWord, window.lastWord + 1);
      const nextStart = last < sentences.length - 1 ? sentences[last + 1].start : null;
      const parts = {
        opening,
        keywords: scoreKeywords(slice),
        rhythm: scoreRhythm(slice, window.durationSec),
        closure: scoreClosure(sentences, last, nextStart, window.durationSec),
      };
      const score = Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + parts[key].score * weight, 0);
      candidates.push({ ...window, firstSentence: first, score, parts });
    }
  }

  if (!candidates.length) {
    // Frases más largas que la ventana (transcript sin puntuación ni pausas): se
    // corta por palabras desde el inicio del discurso.
    let lastWord = 0;
    while (lastWord < words.length - 1 && words[lastWord + 1].end - words[0].start <= maxSec) lastWord++;
    const startSec = snap(Math.max(0, words[0].start - LEAD_IN));
    const endSec = snap(Math.min(totalSec, words[lastWord].end + LEAD_OUT));
    log('warn', 'El transcript no tiene límites de frase utilizables: se toma el inicio del discurso');
    return {
      startSec, endSec, durationSec: Number((endSec - startSec).toFixed(3)), firstWord: 0, lastWord,
      score: null, hook: words.slice(0, 12).map((w) => w.text).join(' '),
      reasons: ['sin límites de frase: ventana desde el inicio del discurso'], breakdown: null, candidates: [], evaluated: 0,
    };
  }

  candidates.sort((a, b) => b.score - a.score || a.startSec - b.startSec);

  // Parámetros de extracción multi-clip universal:
  // Aplica a CUALQUIER duración de video (5 min, 10 min, 15 min, 20 min, 100+ min).
  // Busca el número MÁXIMO posible de clips llamativos sin solapamiento (0% overlap).
  // IMPORTANTE: Respeta siempre la duración natural del clip (mínimo minSec, default 30s;
  // nunca se reduce artificialmente la duración para inflar el conteo).
  const theoreticalMax = Math.max(1, Math.floor(speechSec / minSec));
  const maxClips = Number(options.maxClips) > 0 ? Number(options.maxClips) : (options.single ? 1 : theoreticalMax);
  const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : 0.40;
  const overlapMax = Number.isFinite(Number(options.overlapThreshold)) ? Number(options.overlapThreshold) : 0.001;

  const selectedCandidates = [];
  for (const candidate of candidates) {
    if (candidate.score < minScore && selectedCandidates.length >= 1) continue;
    const hasOverlap = selectedCandidates.some((kept) => overlap(kept, candidate) > overlapMax);
    if (!hasOverlap) {
      selectedCandidates.push(candidate);
      if (selectedCandidates.length >= maxClips) break;
    }
  }

  // Si por el umbral de score no se seleccionó ninguno, tomar al menos el mejor
  if (!selectedCandidates.length && candidates.length) {
    selectedCandidates.push(candidates[0]);
  }

  const describe = (c, idx = 0) => {
    const breakdown = Object.fromEntries(Object.keys(WEIGHTS).map((key) => [key, Number(c.parts[key].score.toFixed(3))]));
    const hookText = sentences[c.firstSentence]?.text || words.slice(c.firstWord, c.firstWord + 10).map((w) => w.text).join(' ');
    // Generar un título conciso a partir del gancho
    const title = hookText.replace(/[.!?…]+$/, '').slice(0, 55).trim();
    return {
      clipId: `clip-${String(idx + 1).padStart(2, '0')}`,
      rank: idx + 1,
      title,
      startSec: c.startSec,
      endSec: c.endSec,
      durationSec: c.durationSec,
      startClock: fmtClock(c.startSec),
      endClock: fmtClock(c.endSec),
      firstWord: c.firstWord,
      lastWord: c.lastWord,
      score: Number(c.score.toFixed(3)),
      scorePercent: Math.round(c.score * 100),
      hook: hookText,
      reasons: Object.keys(WEIGHTS).flatMap((key) => c.parts[key].reasons),
      breakdown,
      wordsPerSec: c.parts.rhythm.wps,
    };
  };

  const allClips = selectedCandidates.map((c, i) => describe(c, i));
  const [best, ...alternatives] = allClips;
  const totalClipsSec = allClips.reduce((acc, c) => acc + c.durationSec, 0);
  const coveragePercent = Math.min(100, Math.round((totalClipsSec / speechSec) * 100));

  log('info', `${candidates.length} ventanas de 30-60s evaluadas en ${sentences.length} frases (${totalSec.toFixed(1)} s total)`);
  log('info', `Duración de voz: ${speechSec.toFixed(1)} s (${(speechSec / 60).toFixed(1)} min). Capacidad máxima teórica: ${theoreticalMax} clips de ${minSec}-${maxSec} s.`);
  log('info', `🔥 ${allClips.length} clips llamativos extraídos sin solapamiento (score ≥ ${Math.round(minScore * 100)}%, cobertura ${coveragePercent}%):`);
  allClips.forEach((c) => {
    log('info', `  [${c.clipId}] ${c.startClock} → ${c.endClock} (${c.durationSec}s) · Score ${c.scorePercent}% · "${c.title}"`);
  });

  return {
    ...best,
    clips: allClips,
    candidates: alternatives,
    evaluated: candidates.length,
    theoreticalMax,
    coveragePercent,
  };
}

/**
 * Función pública para extraer el máximo número de clips enganchadores de cualquier video (5m, 10m, 15m, 20m, 100m+).
 */
export function detectAllHooks(input, context) {
  return detectHook(input, context);
}
