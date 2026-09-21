// The review brief is the substance of kimi_review: everything this tool promises — a fixed output
// contract, a tool budget, a target environment, a duty to say what could not be checked — exists
// only as text in this function. If it silently loses a section, the tool keeps "working" while
// returning essays.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildReviewPrompt } from "../index.mjs";

const base = {
  subject: "ЕГ_ПересчитатьЦены",
  target: "УТ 11.5, расширение",
  focus: "",
  files: [],
  known: "",
  budgetToolCalls: 7,
};

test("the brief carries all four contract sections", () => {
  const prompt = buildReviewPrompt(base);

  for (const section of ["Вердикт", "Находки", "Подтверждено инструментами", "Не смог проверить"]) {
    assert.ok(prompt.includes(section), `missing section: ${section}`);
  }
});

test("the target environment is passed through verbatim", () => {
  assert.ok(buildReviewPrompt(base).includes("УТ 11.5, расширение"));
});

test("the tool budget reaches the brief as a number", () => {
  assert.match(buildReviewPrompt({ ...base, budgetToolCalls: 3 }), /не более 3 вызовов/i);
});

test("without a focus the brief still states what to look at", () => {
  const prompt = buildReviewPrompt(base);

  assert.match(prompt, /корректность|производительность|транзакции/i);
});

test("a supplied focus replaces the default priorities", () => {
  const prompt = buildReviewPrompt({ ...base, focus: "только блокировки" });

  assert.ok(prompt.includes("только блокировки"));
});

test("listed files are named in the brief", () => {
  const prompt = buildReviewPrompt({ ...base, files: ["src/Module.bsl", "src/Form.xml"] });

  assert.ok(prompt.includes("src/Module.bsl"));
  assert.ok(prompt.includes("src/Form.xml"));
});

test("what is already known is passed on, so the budget is not spent re-checking it", () => {
  const prompt = buildReviewPrompt({ ...base, known: "syntaxcheck passed, реквизит подтверждён графом" });

  assert.ok(prompt.includes("syntaxcheck passed"));
});

test("the brief demands verification by tools rather than from memory", () => {
  // Plain substring, not a regex: \w in JavaScript covers ASCII only and never matches Cyrillic.
  assert.ok(buildReviewPrompt(base).includes("а не по памяти"));
});
