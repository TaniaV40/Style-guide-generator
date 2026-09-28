import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI } from '@google/genai';

const MODELS_TO_TRY = ['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-2.0-flash'];

async function generateWithFallback(ai: GoogleGenAI, prompt: string): Promise<string> {
  let lastError: any = null;
  for (const modelName of MODELS_TO_TRY) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
      });
      if (response && response.text) {
        return response.text;
      }
    } catch (err: any) {
      console.warn(`Model ${modelName} failed, trying fallback:`, err.message || err);
      lastError = err;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw lastError || new Error('All model attempts failed');
}

function createExtractionPrompt(sampleNumber: number, sampleText: string): string {
  return `Your task is to look at the writing sample below and select passages for it to use later.

I want you to do the following:

1. Select 300 words of general text for more calmer moments that has more description and such, with less dialogue or action. Reproduce these 300 words verbatim.
2. Select 300 words of text that have more dialogue and conversation in them. Reproduce these 300 words verbatim.
3. Select 300 words of an action scene or highly dramatic moment. Reproduce these 300 words verbatim.
4. If the sample appears to be a comedy, or has highly comedic moments, include an additional 300 words of a comedic scene. Reproduce these 300 words verbatim. If there is NOT a comedy scene in the samples, leave blank.

Format your response in Markdown using the following format.

**Sample ${sampleNumber} Normal Text:**

[INSERT 300 WORDS OF TEXT PULLED VERBATIM FROM THE SAMPLE BELOW]

**Sample ${sampleNumber} Dialogue Text:**

[INSERT 300 WORDS OF TEXT PULLED VERBATIM FROM THE SAMPLE BELOW]

**Sample ${sampleNumber} Action Text:**

[INSERT 300 WORDS OF TEXT PULLED VERBATIM FROM THE SAMPLE BELOW]

**Sample ${sampleNumber} Comedy Text:** [don't include if there is no comedic scenes in the sample.]

[INSERT 300 WORDS OF TEXT PULLED VERBATIM FROM THE SAMPLE BELOW]

If there is no writing sample below, simply print "No writing sample." instead.

Writing Sample ${sampleNumber}:
${sampleText}`;
}

function createSynthesisPrompt(sampleExtractions: { sampleNumber: number; extractedText: string }[]): string {
  const sampleBlocks = sampleExtractions
    .map(s => `<sample_${s.sampleNumber}>\n${s.extractedText}\n</sample_${s.sampleNumber}>`)
    .join('\n\n');

  return `${sampleBlocks}

Given the above writing samples, I want you to draft a prose style sheet, giving instructions on how to write like these samples, and even including small snippets from the samples as examples of your recommendations.

This style sheet is intended for use by an LLM to write fiction in the same style. Be sure to frame your response as instruction on how to write in this style. So you are not just making observations, you're giving instruction.

Follow these rules carefully:

1. Base all observations ONLY on the provided samples.

2. Describe patterns in general terms and give specific examples (quote the samples verbatim).

3. Analyze the writing and create a style guide that covers ONLY the following elements:

-Narrative Rhythm
-Close vs Distant POV
-Formality
-Overall Tone
-Emotional Range
-Average Sentence Length and Rhythm
-Paragraphing
-Average Grade Level
-Dialogue Style
-Sentence Openings
-Clause structure and complexity
-Punctuation habits 
-Emphasis and cadence tricks

Response format (use Markdown):
Use the following exact structure in your response:

# Style Guide

## 1. Narrative Rhythm
- **Summary:** One–two sentences describing the overall pacing and rhythm.
- **Key traits:** Bullet list of 3–5 specific rhythmic habits with examples (e.g., mix of short/long sentences, use of pauses, etc.).

## 2. Close vs Distant POV
- **POV distance:** Explain whether the POV feels very close, moderately close, or distant. (Note, focus only on the distance here, do not mention the actual POV (i.e. don't mention third person, first person, etc.) because this will be determined at a later stage. So just refer to things like the POV distance, mentioning things like show vs tell or deep point of view, as relevant)
- **Evidence:** Brief descriptions of how internal thoughts, emotions, or observations are handled, with examples pulled from the text itself.

## 3. Formality
- **Formality level:** Label as very informal / informal / neutral / formal / very formal.
- **Indicators:** Bullet list of language choices that signal this level.

## 4. Overall Tone
- **Core tone adjectives:** 3–5 adjectives that reliably describe the tone, with a brief explanation of each.
- **Tone stability:** Explain whether the tone stays consistent or shifts noticeably.

## 5. Emotional Range
- **Range description:** Describe how wide the emotional range is (narrow, moderate, wide) in 2-3 setences.
- **Common emotions:** List the emotions that show up most often in the writing with specific examples from the text.

## 6. Average Sentence Length and Rhythm
- **Sentence length:** Characterize the average sentence length (short, medium, long) and variation. 
- **Rhythmic patterns:** Note recurring patterns such as clusters of short sentences, long flowing sentences, fragments, or frequent use of questions. With specific examples from the samples.

## 7. Paragraphing
- **Paragraph length:** Describe typical paragraph length (short, medium, long) and variation.
- **Paragraph function:** Explain how paragraphs are used (e.g., one idea per paragraph, frequent line breaks for emphasis, long blended paragraphs, etc.).

## 8. Average Grade Level
- **Estimated grade level:** Provide an estimated grade-level (a specific grade, not a range).
- **Complexity factors:** Mention what drives this level (sentence complexity, vocabulary difficulty, density of ideas). Give specific examples.

## 9. Dialogue Style
- **Voice and realism:** Characterize how natural, stylized, or heightened the dialogue feels.
- **Tag and beat usage:** Note patterns in dialogue tags (e.g., mostly “said,” varied tags) and action beats. Encourage, in your instruction, to mostly use "said" or "asked" or dialogue beats.

## 10. Sentence Openings
- **Common opening patterns:** Describe the most frequent ways sentences begin (for example, with pronouns, character names, conjunctions, adverbs, or prepositional phrases).
- **Variety vs repetition:** Explain whether sentence openings feel varied or repetitive. (Encourage more variation in sentence openings overall)
- **Distinctive habits:** List any notable quirks (for example, frequent use of “And/But/So” at the start of sentences) and whether they should be treated as features to preserve, to eliminate, or mix in ocassionally.

## 11. Clause Structure and Complexity
- **Typical clause types:** Describe the balance of simple, compound, and complex sentences.
- **Stacking vs splitting:** Explain how often the author stacks multiple clauses in one sentence compared to splitting ideas into separate sentences. Give specific examples.
- **Subordination patterns:** Note any recurring use of subordinating structures (for example, “because,” “although,” “even though”) and how they shape the feel of the prose.

## 12. Punctuation Habits (No Em Dashes)
- **Core punctuation tools:** Describe how the author uses commas, semicolons, colons, parentheses, ellipses, question marks, and exclamation marks.
- **Constraints and guidance:** 
  - Explicitly state that em dashes must NOT be used when imitating this style.
  - Suggest which other punctuation marks should be used instead of em dashes to achieve similar effects (for example, commas, periods, etc.).

## 13. Emphasis and Cadence Tricks
- **Emphasis techniques:** Describe how the author creates emphasis at the sentence level (for example, one-word sentences, fragments, repetition, or contrast).
- **Rhythmic patterns:** Explain any noticeable rhythmic habits (for example, long sentences followed by short punchy ones, clusters of short sentences, or repeated parallel structures).
- **Signature moves:** List 3–5 specific “signature” emphasis or cadence tricks that someone should mimic to reproduce the feel of this style.


## Summarized Style Rules (Checklist)
- Bullet list of 8–15 concrete “do” rules that someone should follow to imitate this style. (make sure each bulleted item is a complete sentence)
- Bullet list of 8–15 “avoid” rules that would break the style. (make sure each bulleted item is a complete sentence)


Do not focus on specific characters or other details from the samples, just focus on the prose style. The style sheet should be thorough.`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { text, sample1, sample2, sample3, normalText, dialogueText, actionText, comedyText } = req.body || {};
    
    const rawSamples: string[] = [];
    if (sample1 && sample1.trim()) rawSamples.push(sample1.trim());
    if (sample2 && sample2.trim()) rawSamples.push(sample2.trim());
    if (sample3 && sample3.trim()) rawSamples.push(sample3.trim());

    if (rawSamples.length === 0 && text && text.trim()) rawSamples.push(text.trim());

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

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY environment variable is not configured.' });
    }

    const ai = new GoogleGenAI({ apiKey });
    const sampleExtractions: { sampleNumber: number; extractedText: string }[] = [];

    for (let i = 0; i < rawSamples.length; i++) {
      const sampleNum = i + 1;
      const extractionPrompt = createExtractionPrompt(sampleNum, rawSamples[i]);
      const extractedText = await generateWithFallback(ai, extractionPrompt);

      sampleExtractions.push({
        sampleNumber: sampleNum,
        extractedText
      });
    }

    const synthesisPrompt = createSynthesisPrompt(sampleExtractions);
    const resultText = await generateWithFallback(ai, synthesisPrompt);

    return res.status(200).json({
      result: resultText,
      sampleExtractions
    });
  } catch (error: any) {
    console.error('API Error:', error);
    return res.status(500).json({ error: error.message || 'An unknown error occurred' });
  }
}
