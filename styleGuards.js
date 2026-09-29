/**
 * styleGuards.js
 * Style Analyst, deterministic guards around the LLM call.
 *
 * No dependencies. Plain JavaScript (ES module). Works in a Next.js / Vercel API route or Node 18+.
 *
 * What it does:
 *   1. computeTextFacts(samples)      -> measures the samples in code (sentence lengths, punctuation,
 *                                        reading grade, POV/tense per sample, word counts).
 *   2. buildFactsBlock(facts)          -> text block to inject into the prompt as fixed facts.
 *   3. renderMeasuredSections(facts)   -> markdown the CODE writes for Sections 6, 8 and 12 (measured parts),
 *                                        replacing {{SENTENCE_FACTS}}, {{GRADE_FACTS}}, {{PUNCTUATION_FACTS}}.
 *   4. validateGuide(markdown, samples, facts) -> list of problems (bad quotes, false punctuation claims,
 *                                        Part 2 gaps, mis-filed dialogue).
 *   5. removeFailingLines(markdown, problems) -> last-resort cleanup: deletes bullet lines that failed.
 *   6. guardedGenerate({ samples, genre, callModel, maxRetries }) -> full pipeline with one or more retries.
 */

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

export function normalise(text) {
  return String(text || '')
    .replace(/[“”„″]/g, '"') // curly double quotes -> "
    .replace(/[‘’‛′]/g, "'") // curly single quotes -> '
    .replace(/…/g, '...')                   // single-character ellipsis -> ...
    .replace(/ /g, ' ')                     // non-breaking space
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

function splitParagraphs(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Splits text into sentences. Dialogue attribution stays with its sentence:
 *   "Right," she said.   -> one sentence
 *   "Nobody does," he said. "The council changed the locks."  -> two sentences
 */
export function splitSentences(text) {
  const out = [];
  for (const para of splitParagraphs(text)) {
    const p = normalise(para);
    // Split after . ! ? (optionally followed by a closing quote) when followed by space + capital or opening quote.
    const parts = p.split(/(?<=[.!?]["']?)\s+(?=["']?[A-Z0-9])/);
    for (const s of parts) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Facts measured in code
// ---------------------------------------------------------------------------

const PUNCTUATION_MARKS = [
  { key: 'comma', label: 'commas', names: ['comma'], test: (t) => (t.match(/,/g) || []).length },
  { key: 'period', label: 'full stops', names: ['full stop', 'period'], test: (t) => (t.match(/\./g) || []).length },
  { key: 'question', label: 'question marks', names: ['question mark'], test: (t) => (t.match(/\?/g) || []).length },
  { key: 'exclamation', label: 'exclamation marks', names: ['exclamation'], test: (t) => (t.match(/!/g) || []).length },
  { key: 'semicolon', label: 'semicolons', names: ['semicolon', 'semi-colon'], test: (t) => (t.match(/;/g) || []).length },
  { key: 'colon', label: 'colons', names: [/(?<!semi-?)\bcolons?\b/], test: (t) => (t.replace(/;/g, '').match(/:/g) || []).length },
  { key: 'ellipsis', label: 'ellipses', names: ['ellipsis', 'ellipses'], test: (t) => (t.match(/\.\.\.|…/g) || []).length },
  { key: 'emdash', label: 'em dashes', names: ['em dash', 'em-dash', 'emdash'], test: (t) => (t.match(/—/g) || []).length },
  { key: 'endash', label: 'en dashes', names: ['en dash', 'en-dash'], test: (t) => (t.match(/–/g) || []).length },
  { key: 'parentheses', label: 'parentheses', names: ['parenthes', 'bracket'], test: (t) => (t.match(/[()]/g) || []).length },
  { key: 'quotes', label: 'quotation marks', names: ['quotation mark'], test: (t) => (t.match(/["“”]/g) || []).length },
];

function countSyllables(word) {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const m = w.match(/[aeiouy]{1,2}/g);
  return Math.max(1, m ? m.length : 1);
}

function fleschKincaidGrade(text) {
  const sentences = splitSentences(text);
  const words = normalise(text).split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (!sentences.length || !words.length) return null;
  const syllables = words.reduce((n, w) => n + countSyllables(w), 0);
  const grade = 0.39 * (words.length / sentences.length) + 11.8 * (syllables / words.length) - 15.59;
  return Math.round(grade * 10) / 10;
}

function stripDialogue(text) {
  return normalise(text).replace(/"[^"]*"/g, ' ');
}

/** Approximate narration POV and tense for one sample (dialogue removed first). */
function narrationProfile(text) {
  const n = ' ' + stripDialogue(text).toLowerCase() + ' ';
  const count = (re) => (n.match(re) || []).length;
  const firstPerson = count(/\b(i|me|my|mine|myself)\b/g);
  const thirdPerson = count(/\b(he|she|him|her|his|hers|they|them|their)\b/g);
  const past = count(/\b(was|were|had|did|said|\w+ed)\b/g);
  const present = count(/\b(is|am|are|has|does|says)\b/g);
  const pov = firstPerson > thirdPerson * 0.5 ? 'first person' : 'third person';
  const tense = present > past * 0.6 ? 'present tense' : 'past tense';
  return { pov, tense, firstPerson, thirdPerson, pastSignals: past, presentSignals: present };
}

/**
 * @param {string[]} samples  the raw sample texts, in slot order (empty slots removed)
 */
export function computeTextFacts(samples) {
  const clean = samples.map((s) => String(s || '')).filter((s) => s.trim());
  const all = clean.join('\n\n');

  const sentences = [];
  clean.forEach((s, i) => {
    for (const text of splitSentences(s)) sentences.push({ sample: i + 1, text, words: countWords(text) });
  });
  const byLength = [...sentences].sort((a, b) => b.words - a.words);

  const punctuation = PUNCTUATION_MARKS.map((m) => ({ ...m, count: m.test(all) }));
  const present = punctuation.filter((p) => p.count > 0);
  const absent = punctuation.filter((p) => p.count === 0);

  const perSample = clean.map((s, i) => ({
    sample: i + 1,
    words: countWords(s),
    paragraphs: splitParagraphs(s).length,
    hasDialogue: /["“”]/.test(s),
    ...narrationProfile(s),
  }));

  const avg = sentences.length ? sentences.reduce((n, s) => n + s.words, 0) / sentences.length : 0;

  return {
    totalWords: countWords(all),
    sentenceCount: sentences.length,
    averageSentenceWords: Math.round(avg * 10) / 10,
    longest: byLength.slice(0, 3),
    shortest: byLength.slice(-3).reverse(),
    punctuationPresent: present.map(({ key, label, count }) => ({ key, label, count })),
    punctuationAbsent: absent.map(({ key, label, names }) => ({ key, label, names })),
    readingGrade: fleschKincaidGrade(all),
    perSample,
    mixedVoice:
      new Set(perSample.map((p) => p.pov)).size > 1 || new Set(perSample.map((p) => p.tense)).size > 1,
  };
}

// ---------------------------------------------------------------------------
// 2. Facts block for the prompt
// ---------------------------------------------------------------------------

export function buildFactsBlock(facts) {
  const lines = [];
  lines.push('MEASURED FACTS (computed by code, these are correct, do not recalculate or contradict them):');
  lines.push(`- Total words: ${facts.totalWords}. Sentences: ${facts.sentenceCount}. Average sentence length: ${facts.averageSentenceWords} words.`);
  lines.push('- Longest sentences:');
  facts.longest.forEach((s) => lines.push(`  - ${s.words} words (Sample ${s.sample}): ${s.text}`));
  lines.push('- Shortest sentences:');
  facts.shortest.forEach((s) => lines.push(`  - ${s.words} words (Sample ${s.sample}): ${s.text}`));
  lines.push(`- Punctuation PRESENT: ${facts.punctuationPresent.map((p) => `${p.label} (${p.count})`).join(', ') || 'none'}.`);
  lines.push(`- Punctuation ABSENT (never claim, recommend or quote these as the author's habits): ${facts.punctuationAbsent.map((p) => p.label).join(', ') || 'none'}.`);
  lines.push(`- Reading grade (Flesch-Kincaid): ${facts.readingGrade}.`);
  facts.perSample.forEach((p) =>
    lines.push(`- Sample ${p.sample}: ${p.words} words, ${p.paragraphs} paragraphs, ${p.pov}, ${p.tense} (approximate), dialogue: ${p.hasDialogue ? 'yes' : 'no'}.`)
  );
  if (facts.mixedVoice) {
    lines.push('- WARNING: the samples do not share one POV/tense. State this plainly in Section 2 and do not describe them as one consistent voice.');
  }
  lines.push('Where the output needs these measurements, write the placeholders {{SENTENCE_FACTS}}, {{GRADE_FACTS}} and {{PUNCTUATION_FACTS}} exactly. Code fills them in.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 3. Sections written by code, not by the model
// ---------------------------------------------------------------------------

export function renderMeasuredSections(facts) {
  const q = (s) => `“${s.text}”`;
  const sentence = [
    `- **Measured sentence length:** average ${facts.averageSentenceWords} words across ${facts.sentenceCount} sentences.`,
    `- **Longest sentences:**`,
    ...facts.longest.map((s) => `  - ${s.words} words: ${q(s)}`),
    `- **Shortest sentences:**`,
    ...facts.shortest.map((s) => `  - ${s.words} word${s.words === 1 ? '' : 's'}: ${q(s)}`),
  ].join('\n');

  const grade = `- **Measured reading grade (Flesch-Kincaid):** ${facts.readingGrade}.`;

  const punctuation = [
    `- **Punctuation used in your samples:** ${facts.punctuationPresent.map((p) => `${p.label} (${p.count})`).join(', ')}.`,
    `- **Not used in your samples:** ${facts.punctuationAbsent.map((p) => p.label).join(', ')}. Do not add these when imitating this style.`,
  ].join('\n');

  return { SENTENCE_FACTS: sentence, GRADE_FACTS: grade, PUNCTUATION_FACTS: punctuation };
}

/** Replaces placeholders. If the model forgot one, inserts it directly under the matching section heading. */
export function injectMeasuredSections(markdown, facts) {
  const blocks = renderMeasuredSections(facts);
  const headingFor = { SENTENCE_FACTS: /^#{1,4}\s*6\.[^\n]*$/m, GRADE_FACTS: /^#{1,4}\s*8\.[^\n]*$/m, PUNCTUATION_FACTS: /^#{1,4}\s*12\.[^\n]*$/m };
  let out = markdown;
  for (const [key, block] of Object.entries(blocks)) {
    const token = `{{${key}}}`;
    if (out.includes(token)) {
      out = out.split(token).join(block);
    } else {
      const m = out.match(headingFor[key]);
      if (m) out = out.replace(m[0], `${m[0]}\n${block}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Validation
// ---------------------------------------------------------------------------

/** Pulls every quoted string from a block of markdown. Curly quotes first (evidence style), then straight quotes. */
function extractQuotes(text) {
  const quotes = [];
  const curly = /“([^”]+)”/g;
  let m;
  while ((m = curly.exec(text))) quotes.push(m[1]);
  for (const line of text.split('\n')) {
    if (/[“”]/.test(line)) continue;
    const straight = /"([^"]{2,})"/g;
    while ((m = straight.exec(line))) quotes.push(m[1]);
  }
  return quotes;
}

/**
 * A quote passes if it appears word for word in the samples.
 * "..." inside or at the edges of a quote is treated as a truncation mark: each fragment must exist, in order.
 */
export function quoteExists(quote, sourceNormalised) {
  const q = normalise(quote);
  const fragments = q.split(/\s*\.\.\.\s*/).map((f) => f.trim()).filter(Boolean);
  if (!fragments.length) return true;
  let from = 0;
  for (const frag of fragments) {
    const candidates = [frag, frag.replace(/[.,]$/, '')];
    let found = -1;
    for (const c of candidates) {
      if (!c) continue;
      const idx = sourceNormalised.indexOf(c, from);
      if (idx !== -1) { found = idx + c.length; break; }
    }
    if (found === -1) return false;
    from = found;
  }
  return true;
}

const NEGATION = /\b(not|never|no|avoid|don't|do not|must not|absent|without|instead of|not used)\b/i;

/**
 * @returns {{ ok: boolean, problems: Array<{type:string, line?:string, detail:string}> }}
 */
export function validateGuide(markdown, samples, facts) {
  const problems = [];
  const source = normalise(samples.join('\n\n'));
  const part2Start = markdown.search(/part 2/i);
  const part1 = part2Start === -1 ? markdown : markdown.slice(0, part2Start);
  const part2 = part2Start === -1 ? '' : markdown.slice(part2Start);

  // 4a. Every quote in Part 1 must exist word for word.
  for (const line of part1.split('\n')) {
    for (const quote of extractQuotes(line)) {
      if (countWords(quote) < 2 && !/[.!?]$/.test(quote.trim())) continue;
      if (!quoteExists(quote, source)) {
        problems.push({ type: 'quote_not_in_source', line, detail: `Quote not found word for word: "${quote}"` });
      }
    }
  }

  // 4b. No positive claim about punctuation that is absent from the samples.
  for (const line of part1.split('\n')) {
    const lower = line.toLowerCase();
    for (const mark of facts.punctuationAbsent) {
      const hit = mark.names.some((n) => (n instanceof RegExp ? n.test(lower) : lower.includes(n)));
      if (hit && !NEGATION.test(line)) {
        problems.push({ type: 'absent_punctuation_claimed', line, detail: `Claims ${mark.label}, which the samples do not contain.` });
      }
    }
  }

  // 4c. Part 2 must contain every paragraph of every sample.
  if (part2) {
    const p2 = normalise(part2);
    samples.forEach((s, i) => {
      splitParagraphs(s).forEach((para) => {
        if (!p2.includes(normalise(para))) {
          problems.push({ type: 'part2_missing_paragraph', detail: `Sample ${i + 1} paragraph missing from Part 2: "${normalise(para).slice(0, 80)}..."` });
        }
      });
    });
  } else {
    problems.push({ type: 'part2_missing', detail: 'Part 2 not found in output.' });
  }

  // 4d. A sample whose "Dialogue Text" block contains no quotation marks at all has narration mis-filed as dialogue.
  const dialogueBlocks = part2.split(/(?=Sample \d+ (?:Normal|Dialogue|Action|Comedy) Text:)/i).filter((b) => /Dialogue Text:/i.test(b));
  for (const block of dialogueBlocks) {
    const body = block.replace(/^[\s\S]*?Dialogue Text:\s*/i, '').replace(/---[\s\S]*$/, '').trim();
    if (body && !/^no dialogue/i.test(body) && !/["\u201C\u201D]/.test(body)) {
      problems.push({ type: 'non_dialogue_in_dialogue', detail: `"Dialogue Text" contains no dialogue at all: "${normalise(body).slice(0, 80)}...". Write "No dialogue in this sample." instead.` });
    }
  }

  // 4e. Placeholders left over
  if (/\{\{[A-Z_]+\}\}/.test(markdown)) problems.push({ type: 'placeholder_left', detail: 'A {{PLACEHOLDER}} was not filled.' });

  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// 5. Last-resort cleanup
// ---------------------------------------------------------------------------

export function removeFailingLines(markdown, problems) {
  const bad = new Set(problems.filter((p) => p.line).map((p) => p.line));
  return markdown
    .split('\n')
    .filter((l) => !bad.has(l))
    .join('\n');
}

// ---------------------------------------------------------------------------
// 6. Full pipeline
// ---------------------------------------------------------------------------

/**
 * @param {object}   args
 * @param {string[]} args.samples     raw sample texts (1 to 3)
 * @param {string}   [args.genre]
 * @param {(extraPromptText: string) => Promise<string>} args.callModel
 *        Your existing LLM call. It receives text to APPEND to your current prompt and must return the markdown guide.
 * @param {number}   [args.maxRetries=1]
 * @returns {Promise<{ markdown: string, facts: object, problems: object[], attempts: number }>}
 */
export async function guardedGenerate({ samples, genre, callModel, maxRetries = 1 }) {
  const clean = samples.filter((s) => s && s.trim());
  const facts = computeTextFacts(clean);
  const factsBlock = buildFactsBlock(facts);

  let attempt = 0;
  let extra = factsBlock;
  let markdown = '';
  let result = { ok: false, problems: [] };

  while (attempt <= maxRetries) {
    attempt += 1;
    markdown = injectMeasuredSections(await callModel(extra), facts);
    result = validateGuide(markdown, clean, facts);
    if (result.ok) break;
    extra =
      factsBlock +
      '\n\nYOUR PREVIOUS ANSWER FAILED THESE CHECKS. Fix every one. Quote only text that appears word for word in the samples.\n' +
      result.problems.map((p) => `- ${p.detail}`).join('\n');
  }

  if (!result.ok) {
    markdown = removeFailingLines(markdown, result.problems);
    result = validateGuide(markdown, clean, facts);
  }

  return { markdown, facts, problems: result.problems, attempts: attempt, genre };
}
