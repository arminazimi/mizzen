/**
 * A model-agnostic token estimate: no tokenizer, no vendor, no network, no clock. The same text gives the same
 * estimate on every run and on every machine.
 *
 * Tokenizers disagree: the same English paragraph can cost one token per word in one vocabulary and three in
 * another. An estimator that is close to all of them is more useful than one that is exact for a single vendor, so
 * this module counts by script and by the shape of the text instead of by a merges table:
 *
 * - **Latin words** cost one token per eight characters, at least one, which follows the finding that a word and
 *   its leading space are usually one token in a modern vocabulary while a long or rare word splits into two or
 *   three. The same rate prices code identifiers (`readFileSync`, `estimateTokens`, `MAX_RETRIES`) at what their
 *   camelCase and snake_case splits tend to cost. **Cyrillic and Greek words** cost one token per 2.4 characters,
 *   because those vocabularies are thinner and a long word takes more pieces.
 * - **Persian, Arabic, and other Arabic-script words** cost one token per 1.35 characters, at least one, because
 *   those vocabularies are the thinnest and a word of four letters often takes three tokens. A zero-width
 *   non-joiner (`U+200C`, the Persian half-space) ends a word the way a space does, so `فایل‌های` is priced as two
 *   words.
 * - **Han and Kana** cost one token per character, which is what a character-based vocabulary charges; Hangul
 *   syllables are grouped a little more often, so they cost 0.9.
 * - **Digits** cost one token per three digits, as digit groups are usually learned in threes, plus one token when
 *   the run starts after whitespace, because a space before a number does not merge into its token.
 * - **Punctuation and symbols** cost one token per two characters, at least one for a non-empty run.
 * - **Whitespace** costs one token per two line breaks: a line ending usually merges into the token beside it,
 *   while a blank line between paragraphs is a token of its own. Spaces around words are already counted by the
 *   word, and indentation is not counted separately.
 *
 * The estimate was measured against the `cl100k_base` vocabulary, a common reference tokenizer, on the corpus in
 * `packages/engine/test/packs-tokens.test.ts`: English, Persian, TypeScript, and Chinese come out within
 * {@link TOKEN_ERROR_MARGIN} of the reference count, and the test fails outside that margin. Other vocabularies
 * differ, especially for rare scripts, so treat the margin as a planning budget rather than a guarantee.
 */

/** How far the estimate may sit from the reference count on the test corpus, as a fraction. */
export const TOKEN_ERROR_MARGIN = 0.15;

/** The name the estimate reports as its method: script-aware counting, no tokenizer. */
export const TOKEN_METHOD = "script-aware";

/** A token estimate and the method that produced it. */
export interface TokenEstimate {
  /** Estimated tokens: a non-negative integer. */
  readonly tokens: number;
  /** Always {@link TOKEN_METHOD}; lets a reader record how a number was made. */
  readonly method: string;
}

/** Characters per token inside a word, per script. Higher means cheaper text. */
const WORD_CHARS_PER_TOKEN = {
  latin: 8,
  cyrillic: 2.4,
  greek: 2.4,
  arabic: 1.35,
} as const;

/** Tokens per character for scripts written without spaces between words. */
const CHARACTER_TOKENS = {
  han: 1,
  kana: 1,
  hangul: 0.9,
} as const;

/** Digits per token: vocabularies group digits in threes. */
const DIGITS_PER_TOKEN = 3;

/** Symbol characters per token. */
const SYMBOLS_PER_TOKEN = 2;

/**
 * One run of text of a single kind. The order matters: a script-specific alternative comes before `letters`, so
 * Persian is not counted as generic letters, and whitespace and symbols catch everything else.
 */
const RUNS =
  /(\s+)|(\p{Script=Han}+)|([\p{Script=Hiragana}\p{Script=Katakana}]+)|(\p{Script=Hangul}+)|([\p{Script=Arabic}\u200C\u0640]+)|(\p{Script=Cyrillic}+)|(\p{Script=Greek}+)|([\p{L}\p{M}]+)|(\p{Nd}+)|([^\s\p{L}\p{Nd}]+)/gu;

/** A word's cost: at least one token, then one per `charsPerToken` characters. */
function wordTokens(length: number, charsPerToken: number): number {
  return Math.max(1, Math.ceil(length / charsPerToken));
}

/** Code points, not UTF-16 code units, so a character outside the basic plane counts once. */
function characters(run: string): number {
  return [...run].length;
}

/**
 * Estimates the tokens `text` would take, and names the method. Pure: no tokenizer, no dependency, no state.
 *
 * The empty string is zero tokens. Text of a script this module does not name (Devanagari, Hebrew, Thai, and the
 * like) is counted as generic letters at the Latin rate and reported the same way, which keeps the function total
 * instead of throwing; the estimate for those scripts is the least reliable.
 */
export function estimateTokens(text: string): TokenEstimate {
  let tokens = 0;
  for (const match of text.matchAll(RUNS)) {
    const run = match[0];
    if (match[1] !== undefined) {
      // Spaces ride with the word; only blank lines cost on their own.
      tokens += Math.floor((run.match(/\n/g) ?? []).length / 2);
    } else if (match[2] !== undefined) {
      tokens += Math.ceil(characters(run) * CHARACTER_TOKENS.han);
    } else if (match[3] !== undefined) {
      tokens += Math.ceil(characters(run) * CHARACTER_TOKENS.kana);
    } else if (match[4] !== undefined) {
      tokens += Math.ceil(characters(run) * CHARACTER_TOKENS.hangul);
    } else if (match[5] !== undefined) {
      // A zero-width non-joiner ends a word; the joiner itself is folded into the next word's cost.
      for (const word of run.split("\u200C")) {
        if (word !== "") tokens += wordTokens(characters(word), WORD_CHARS_PER_TOKEN.arabic);
      }
    } else if (match[6] !== undefined) {
      tokens += wordTokens(characters(run), WORD_CHARS_PER_TOKEN.cyrillic);
    } else if (match[7] !== undefined) {
      tokens += wordTokens(characters(run), WORD_CHARS_PER_TOKEN.greek);
    } else if (match[8] !== undefined) {
      tokens += wordTokens(characters(run), WORD_CHARS_PER_TOKEN.latin);
    } else if (match[9] !== undefined) {
      tokens += Math.ceil(characters(run) / DIGITS_PER_TOKEN);
      // A space before a number stays a token of its own instead of merging into the digits.
      const before = match.index > 0 ? (text[match.index - 1] ?? "") : "";
      if (/\s/u.test(before)) tokens += 1;
    } else {
      tokens += Math.ceil(characters(run) / SYMBOLS_PER_TOKEN);
    }
  }
  return { tokens, method: TOKEN_METHOD };
}
