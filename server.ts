import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { computeTextFacts, buildFactsBlock, injectMeasuredSections, validateGuide, removeFailingLines } from './styleGuards.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3005;

app.use(express.json({ limit: '10mb' }));

async function generateText(prompt: string): Promise<string> {
  const openAiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPEN_AI_KEY;
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_KEY;

  const errors: string[] = [];

  // 1. Try OpenAI ChatGPT if OPENAI_API_KEY is provided
  if (openAiKey) {
    try {
      const openai = new OpenAI({ apiKey: openAiKey });
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
      });
      const resultText = completion.choices[0]?.message?.content;
      if (resultText) {
        return resultText;
      }
    } catch (err: any) {
      console.warn('OpenAI API error:', err.message || err);
      errors.push(`OpenAI: ${err.message || err}`);
    }
  }

  // 2. Try Gemini if GEMINI_API_KEY is provided or as fallback
  if (geminiKey) {
    const ai = new GoogleGenAI({ apiKey: geminiKey });
    const geminiModels = ['gemini-3.8-flash', 'gemini-3.6-flash'];
    for (const modelName of geminiModels) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: prompt,
          });
          if (response && response.text) {
            return response.text;
          }
        } catch (err: any) {
          console.warn(`Gemini ${modelName} attempt ${attempt} error:`, err.message || err);
          errors.push(`Gemini (${modelName} attempt ${attempt}): ${err.message || err}`);
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }
  }

  if (!openAiKey && !geminiKey) {
    throw new Error('Neither OPENAI_API_KEY nor GEMINI_API_KEY is set in environment variables.');
  }

  throw new Error(`Generation failed across configured providers. ${errors.join('; ')}`);
}

function createExtractionPrompt(sampleNumber: number, sampleText: string): string {
  return `Your task is to look at the writing sample below and select representative passages for it to use later.

I want you to do the following:

1. Select roughly 300 words of general text for calmer moments, more description, less dialogue or action. Reproduce this passage exactly as it appears in the source, character-for-character, including every sentence in the selected range and the original paragraph breaks. Do not skip, merge, smooth grammar, or summarise any sentence within the passage you select.
2. Select roughly 300 words of text that have more dialogue and conversation in them. Reproduce this passage exactly as it appears in the source, character-for-character, including original paragraph breaks and exact punctuation/spelling.
3. Select roughly 300 words of an action scene or highly dramatic moment. Reproduce this passage exactly as it appears in the source, character-for-character, including original paragraph breaks.
4. If the sample contains comedic moments, select roughly 300 words of a comedic scene. Reproduce this passage exactly as it appears in the source, character-for-character, including original paragraph breaks. If there are NO comedic moments in the sample, leave the Comedy Text section out entirely rather than printing a placeholder.

Word-Count & Integrity Check:
After selecting each passage, count its words. If it differs from the selected source range by more than a few words, you have dropped or altered content; re-select the passage from the original text to ensure 100% sentence and paragraph preservation.

Format your response in Markdown using the following exact structure:

**Sample ${sampleNumber} Normal Text:**

[INSERT ~300 WORDS OF TEXT PULLED VERBATIM FROM THE SAMPLE BELOW, PRESERVING ALL ORIGINAL PARAGRAPH BREAKS]

**Sample ${sampleNumber} Dialogue Text:**

[INSERT ~300 WORDS OF TEXT PULLED VERBATIM FROM THE SAMPLE BELOW, PRESERVING ALL ORIGINAL PARAGRAPH BREAKS]

**Sample ${sampleNumber} Action Text:**

[INSERT ~300 WORDS OF TEXT PULLED VERBATIM FROM THE SAMPLE BELOW, PRESERVING ALL ORIGINAL PARAGRAPH BREAKS]

**Sample ${sampleNumber} Comedy Text:** [Omit section completely if there are no comedic scenes in the sample.]

[INSERT ~300 WORDS OF TEXT PULLED VERBATIM FROM THE SAMPLE BELOW, PRESERVING ALL ORIGINAL PARAGRAPH BREAKS]

If the writing sample input field below is empty, print "No writing sample." instead.

Writing Sample ${sampleNumber}:
${sampleText}`;
}

function createSynthesisPrompt(sampleExtractions: { sampleNumber: number; extractedText: string }[], genre?: string, factsBlock?: string): string {
  const sampleBlocks = sampleExtractions
    .map(s => `<sample_${s.sampleNumber}>\n${s.extractedText}\n</sample_${s.sampleNumber}>`)
    .join('\n\n');

  const genreContextStr = genre ? `Genre Context: ${genre} (for context only, analyze prose style strictly based on the samples provided)\n\n` : '';
  const factsStr = factsBlock ? `${factsBlock}\n\n` : '';

  return `${genreContextStr}${factsStr}${sampleBlocks}

Given the above writing samples, I want you to draft a prose style sheet, giving instructions on how to write like these samples, and including small verbatim snippets from the samples as examples of your recommendations.

This style sheet is intended for use by an LLM to write fiction in the same style. Be sure to frame your response as instruction on how to write in this style. You are giving instruction, not just making observations.

Follow these rules carefully:

1. Base all observations ONLY on the provided samples. Do not invent habits, claim punctuation that is not present, or quote text that does not exist in the samples.

2. CRITICAL VERBATIM QUOTING RULE: Every quoted example MUST be copied character-for-character from the sample text, including its original punctuation, spelling, grammar, and any first-draft errors.
   - Do NOT correct grammar, fix typos, complete sentences, add or remove contractions, or change punctuation in a quote.
   - Do NOT substitute a pronoun or generic reference for a character's name, or a character's name for a pronoun.
   - If a quote must be shortened, cut ONLY from the end and mark the cut with an ellipsis ("..."), never mid-clause without marking it.
   - If you cannot find a real, verbatim quote that demonstrates a claim, do not invent one and do not include that claim.

3. EVIDENCE-MATCH & GRAMMAR TERMINOLOGY RULE: 
   - Every quoted example MUST directly demonstrate the specific claim it is attached to before including it. A quote drawn from a different character's dialogue must NOT be used as evidence of the point-of-view character's internal traits unless the section is explicitly about dialogue in general.
   - Double-check any grammatical terminology (e.g. adverbs vs conjunctions, clause types) before naming them to ensure 100% technical accuracy.

4. SENTENCE LENGTH GROUNDING RULE: Refer to the MEASURED FACTS above. Base your length and complexity claims strictly on what these actual sentences show. Write {{SENTENCE_FACTS}} in Section 6.

5. PUNCTUATION ACCURACY RULE: Refer to the MEASURED FACTS above. Do NOT claim or recommend punctuation marked as ABSENT. Write {{PUNCTUATION_FACTS}} in Section 12.

6. GRADE LEVEL RULE: Write {{GRADE_FACTS}} in Section 8.

7. AVOID LIST RULE: Every item in the Avoid list MUST correspond directly to something observed in the sample (a habit to stop, or the direct opposite of a Do item). Do NOT include generic craft or storytelling advice (such as plot, characterization, or story-level pacing). Limit the Avoid list strictly to 8–10 concrete items.

8. SELF-CHECK & CONSISTENCY: Re-read every quoted example against the sample text. If any quote does not match character-for-character, replace it with a real verbatim quote or remove the claim.

Response format (use Markdown):
Use the following exact structure in your response:

# Style Guide

## 1. Narrative Rhythm
- **Summary:** One–two sentences describing the overall pacing and rhythm.
- **Key traits:** Bullet list of 3–5 specific rhythmic habits with exact verbatim examples (e.g., mix of short/long sentences, use of pauses, etc.).

## 2. Close vs Distant POV
- **POV distance:** Explain whether the POV feels very close, moderately close, or distant. (Note: focus only on the distance here, do not mention the actual POV such as first person or third person, as this will be determined at a later stage. Refer to distance, show vs tell, deep point of view, as relevant).
- **Evidence:** Brief descriptions of how internal thoughts, emotions, or observations are handled, with exact verbatim examples pulled from the text itself.

## 3. Formality
- **Formality level:** Label as very informal / informal / neutral / formal / very formal.
- **Indicators:** Bullet list of language choices that signal this level, with exact verbatim quotes.

## 4. Overall Tone
- **Core tone adjectives:** 3–5 adjectives that reliably describe the tone, with a brief explanation of each.
- **Tone stability:** Explain whether the tone stays consistent or shifts noticeably.

## 5. Emotional Range
- **Range description:** Describe how wide the emotional range is (narrow, moderate, wide) in 2-3 sentences.
- **Common emotions:** List the emotions that show up most often in the writing with exact verbatim examples from the text.

## 6. Average Sentence Length and Rhythm
{{SENTENCE_FACTS}}
- **Rhythmic patterns:** Note recurring patterns such as clusters of short sentences, long flowing multi-clause sentences, fragments, or frequent use of questions, with exact verbatim examples.

## 7. Paragraphing
- **Paragraph length:** Describe typical paragraph length (short, medium, long) and variation.
- **Paragraph function:** Explain how paragraphs are used (e.g., one idea per paragraph, frequent line breaks for emphasis, long blended paragraphs, etc.), ensuring paragraph length and function bullets are mutually consistent.

## 8. Average Grade Level
{{GRADE_FACTS}}
- **Complexity factors:** Mention what drives this level (sentence complexity, vocabulary difficulty, density of ideas) with exact verbatim examples.

## 9. Dialogue Style
- **Voice and realism:** Characterize how natural, stylized, or heightened the dialogue feels.
- **Tag and beat usage:** Note patterns in dialogue tags (e.g., mostly “said,” varied tags) and action beats based strictly on dialogue tags actually present in the sample. Encourage, in your instruction, to mostly use "said" or "asked" or dialogue beats.

## 10. Sentence Openings
- **Common opening patterns:** Describe the most frequent ways sentences begin (for example, with pronouns, character names, conjunctions, adverbs, or prepositional phrases). Double-check grammatical word-class labels.
- **Variety vs repetition:** Explain whether sentence openings feel varied or repetitive.
- **Distinctive habits:** List any notable quirks (for example, frequent use of “And/But/So” at the start of sentences) and whether they should be treated as features to preserve, eliminate, or mix in occasionally.

## 11. Clause Structure and Complexity
- **Typical clause types:** Describe the balance of simple, compound, and complex sentences.
- **Stacking vs splitting:** Explain how often the author stacks multiple clauses in one sentence compared to splitting ideas into separate sentences, supported by exact verbatim examples.
- **Subordination patterns:** Note any recurring use of subordinating structures (for example, “because,” “although,” “even though”) and how they shape the feel of the prose.

## 12. Punctuation Habits (No Em Dashes)
{{PUNCTUATION_FACTS}}
- **Constraints and guidance:** 
  - Explicitly state that em dashes must NOT be used when imitating this style.
  - Suggest which other punctuation marks should be used instead of em dashes to achieve similar effects (for example, commas, periods, etc.).

## 13. Emphasis and Cadence Tricks
- **Emphasis techniques:** Describe how the author creates emphasis at the sentence level (for example, one-word sentences, fragments, repetition, or contrast).
- **Rhythmic patterns:** Explain any noticeable rhythmic habits (for example, long sentences followed by short punchy ones, clusters of short sentences, or repeated parallel structures).
- **Signature moves:** List 3–5 specific “signature” emphasis or cadence tricks that someone should mimic to reproduce the feel of this style.


## Summarized Style Rules (Checklist)
- Bullet list of 8–15 concrete “do” rules that someone should follow to imitate this style. (Make sure each bulleted item is a complete sentence).
- Bullet list of 8–10 concrete “avoid” rules that directly correspond to observed prose-style habits in the sample or the opposite of Do rules. Do NOT include generic storytelling, plot, or characterization advice. (Make sure each bulleted item is a complete sentence).


Do not focus on specific characters or other details from the samples, just focus on the prose style. The style sheet should be thorough.`;
}

app.post('/api/analyze', async (req, res) => {
  try {
    const { text, sample1, sample2, sample3, genre, normalText, dialogueText, actionText, comedyText } = req.body;
    
    const rawSamples: string[] = [];

    if (sample1 && sample1.trim()) rawSamples.push(sample1.trim());
    if (sample2 && sample2.trim()) rawSamples.push(sample2.trim());
    if (sample3 && sample3.trim()) rawSamples.push(sample3.trim());

    if (rawSamples.length === 0 && text && text.trim()) {
      rawSamples.push(text.trim());
    }

    if (rawSamples.length === 0 && (normalText || dialogueText || actionText || comedyText)) {
      const parts = [];
      if (normalText) parts.push(`NORMAL TEXT:\n${normalText}`);
      if (dialogueText) parts.push(`DIALOGUE TEXT:\n${dialogueText}`);
      if (actionText) parts.push(`ACTION TEXT:\n${actionText}`);
      if (comedyText) parts.push(`COMEDY TEXT:\n${comedyText}`);
      rawSamples.push(parts.join('\n\n'));
    }

    if (rawSamples.length === 0) {
      return res.status(400).json({ error: 'At least one writing sample is required.' });
    }

    // Compute deterministic text facts
    const facts = computeTextFacts(rawSamples);
    const factsBlock = buildFactsBlock(facts);

    const sampleExtractions: { sampleNumber: number; extractedText: string }[] = [];

    for (let i = 0; i < rawSamples.length; i++) {
      const sampleNum = i + 1;
      const extractionPrompt = createExtractionPrompt(sampleNum, rawSamples[i]);
      const extractedText = await generateText(extractionPrompt);

      sampleExtractions.push({
        sampleNumber: sampleNum,
        extractedText
      });
    }

    // Synthesis phase with Facts Block & Guarded Validation Pipeline
    let synthesisPrompt = createSynthesisPrompt(sampleExtractions, genre, factsBlock);
    let resultText = await generateText(synthesisPrompt);

    // Inject measured sections in code (Section 6, 8, 12)
    resultText = injectMeasuredSections(resultText, facts);

    // Validate guide against source text & facts
    let validation = validateGuide(resultText, rawSamples, facts);

    if (!validation.ok) {
      console.warn('First pass failed validation:', validation.problems);
      // Retry once with detailed feedback
      const retryPrompt = `${synthesisPrompt}\n\nYOUR PREVIOUS ANSWER FAILED THESE CHECKS. Fix every one. Quote only text that appears word for word in the samples:\n` +
        validation.problems.map(p => `- ${p.detail}`).join('\n');
      
      try {
        let retryText = await generateText(retryPrompt);
        retryText = injectMeasuredSections(retryText, facts);
        const retryVal = validateGuide(retryText, rawSamples, facts);
        if (retryVal.ok || retryVal.problems.length < validation.problems.length) {
          resultText = retryText;
          validation = retryVal;
        }
      } catch (err) {
        console.warn('Retry attempt error:', err);
      }
    }

    // Final cleanup pass for any remaining failing lines
    if (!validation.ok) {
      resultText = removeFailingLines(resultText, validation.problems);
    }

    res.json({
      result: resultText,
      sampleExtractions
    });
  } catch (error: any) {
    console.error('API Error:', error);
    res.status(500).json({ error: error.message || 'An unknown error occurred' });
  }
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
