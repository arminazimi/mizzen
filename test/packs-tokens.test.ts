import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTokens, TOKEN_ERROR_MARGIN, TOKEN_METHOD } from "../src/packs/tokens.ts";

const ENGLISH =
  "Mizzen builds a docs site from Markdown. It reads the configuration file, discovers pages, and renders them with the theme. Every build is deterministic: the same input gives byte-identical output, in the same order, with LF line endings. When a page has an error, the engine still writes the site and reports the diagnostic with its source position.";

const PERSIAN =
  "اسلیپوی یک سایت مستندات را از فایل‌های مارک‌داون می‌سازد. پیکربندی سایت در فایل mizzen.yml قرار دارد و هر مسیر در آن نسبت به ریشه سایت خوانده می‌شود. ساخت خروجی قطعی است: ورودی یکسان، خروجی یکسان بایت‌به‌بایت می‌دهد، با همان ترتیب و با پایان خط LF. وقتی صفحه‌ای خطا داشته باشد، موتور سایت را می‌نویسد و خطا را با موقعیت منبع گزارش می‌کند.";

const TYPESCRIPT = `export function tokens(text: string): number {
  const words = text.split(/\\s+/);
  let total = 0;
  for (const word of words) {
    total += Math.max(1, Math.ceil(word.length / 4));
  }
  return total;
}`;

const CHINESE = "Mizzen 从 Markdown 构建文档站点。它读取配置文件，发现页面并用主题渲染。相同的输入产生字节完全相同的输出。";

/**
 * The fixture corpus. Each entry pairs a text with the number of tokens `cl100k_base` — a common reference
 * tokenizer, the vocabulary behind GPT-4 — produces for it, recorded as a constant here so the test needs no
 * tokenizer and no dependency. `cl100k_base` is a reference, not a target: the estimator is model-agnostic and the
 * same margin has to hold against any modern vocabulary.
 */
const CORPUS: readonly { readonly name: string; readonly text: string; readonly reference: number }[] = [
  { name: "English", text: ENGLISH, reference: 73 },
  { name: "Persian", text: PERSIAN, reference: 234 },
  { name: "TypeScript", text: TYPESCRIPT, reference: 58 },
  { name: "Chinese", text: CHINESE, reference: 49 },
];

test("every fixture stays within the documented error margin of the reference count", () => {
  for (const { name, text, reference } of CORPUS) {
    const estimate = estimateTokens(text);
    assert.equal(estimate.method, TOKEN_METHOD, `${name} names its method`);
    assert.ok(Number.isInteger(estimate.tokens), `${name} estimates a whole number of tokens`);
    const error = Math.abs(estimate.tokens - reference) / reference;
    assert.ok(
      error <= TOKEN_ERROR_MARGIN,
      `${name}: ${estimate.tokens} tokens against ${reference}, ${(error * 100).toFixed(1)}% off, margin ${TOKEN_ERROR_MARGIN * 100}%`,
    );
    assert.ok(estimate.upper >= reference, `${name}: the upper bound ${estimate.upper} covers the reference ${reference}`);
  }
});

test("the estimate reports its uncertainty, and the upper bound is the estimate plus the margin", () => {
  const estimate = estimateTokens(ENGLISH);
  assert.equal(estimate.margin, TOKEN_ERROR_MARGIN);
  assert.equal(estimate.upper, Math.ceil(estimate.tokens * (1 + TOKEN_ERROR_MARGIN)));
  assert.ok(estimate.upper > estimate.tokens);
  assert.deepEqual(estimateTokens(""), { tokens: 0, method: TOKEN_METHOD, margin: TOKEN_ERROR_MARGIN, upper: 0 });
});

test("the estimate is deterministic and reports the script-aware method", () => {
  assert.deepEqual(estimateTokens(ENGLISH), estimateTokens(ENGLISH));
  assert.deepEqual(estimateTokens(ENGLISH), { tokens: 75, method: "script-aware", margin: TOKEN_ERROR_MARGIN, upper: 87 });
  assert.equal(estimateTokens("").tokens, 0);
  assert.equal(TOKEN_METHOD, "script-aware");
});

test("the script rules differ, so Persian and Chinese are not counted as English", () => {
  // Per character, Persian costs more than twice what English does.
  assert.ok(estimateTokens(PERSIAN).tokens / PERSIAN.length > 2 * (estimateTokens(ENGLISH).tokens / ENGLISH.length));
  // Han characters cost one token each, which is what a character-based vocabulary charges.
  assert.equal(estimateTokens("文档站点").tokens, 4);
  // A one-letter word is still one token, and a long identifier splits into a few.
  assert.equal(estimateTokens("a word here").tokens, 3);
  assert.equal(estimateTokens("readFileSync").tokens, 2);
});
