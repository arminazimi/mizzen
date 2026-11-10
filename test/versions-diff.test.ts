import assert from "node:assert/strict";
import { test } from "node:test";
import { diffMarkdown } from "../src/versions/diff.ts";

const EMPTY = { added: [], removed: [], changed: [], moved: [] };

test("reports a section only the new document has as added", () => {
  const oldText = "# Keep\n\nsame\n\n# Gone\n\nold\n";
  const newText = "# Keep\n\nsame\n\n# Fresh\n\nnew\n";
  const diff = diffMarkdown(oldText, newText);

  assert.equal(diff.changed.length, 0);
  assert.equal(diff.moved.length, 0);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.deepEqual(diff.added[0], {
    heading: "Fresh",
    id: "fresh",
    occurrence: 1,
    newText: "# Fresh\n\nnew\n",
    newRange: { start: 5, end: 7 },
  });
  assert.deepEqual(diff.removed[0], {
    heading: "Gone",
    id: "gone",
    occurrence: 1,
    oldText: "# Gone\n\nold\n",
    oldRange: { start: 5, end: 7 },
  });
});

test("reports the same section with a different body as changed", () => {
  const oldText = "# A\n\none\n\n# B\n\ntwo\n";
  const newText = "# A\n\none changed\n\n# B\n\ntwo\n";
  const diff = diffMarkdown(oldText, newText);

  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.moved.length, 0);
  assert.deepEqual(diff.changed, [
    {
      heading: "A",
      id: "a",
      occurrence: 1,
      oldText: "# A\n\none\n\n",
      oldRange: { start: 1, end: 4 },
      newText: "# A\n\none changed\n\n",
      newRange: { start: 1, end: 4 },
    },
  ]);
});

test("a reordered section is moved, not removed and added", () => {
  const oldText = "# A\na\n\n# B\nb\n\n# C\nc\n";
  const newText = "# B\nb\n\n# A\na\n\n# C\nc\n";
  const diff = diffMarkdown(oldText, newText);

  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.changed.length, 0);
  assert.deepEqual(diff.moved, [
    {
      heading: "B",
      id: "b",
      occurrence: 1,
      oldText: "# B\nb\n\n",
      oldRange: { start: 4, end: 6 },
      newText: "# B\nb\n\n",
      newRange: { start: 1, end: 3 },
    },
  ]);
});

test("a moved section keeps both bodies when it also changed", () => {
  const oldText = "# A\na\n\n# B\nb\n";
  const newText = "# B\nb changed\n\n# A\na\n";
  const diff = diffMarkdown(oldText, newText);

  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.changed.length, 0);
  assert.equal(diff.moved.length, 1);
  assert.equal(diff.moved[0]?.heading, "B");
  assert.equal(diff.moved[0]?.oldText, "# B\nb\n");
  assert.equal(diff.moved[0]?.newText, "# B\nb changed\n\n");
  assert.deepEqual(diff.moved[0]?.oldRange, { start: 4, end: 5 });
  assert.deepEqual(diff.moved[0]?.newRange, { start: 1, end: 3 });
});

test("duplicate heading text is told apart by its occurrence number", () => {
  const oldText = "# Setup\none\n\n# Setup\ntwo\n\n# End\ndone\n";
  const newText = "# Setup\none\n\n# Setup\ntwo changed\n\n# End\ndone\n";
  const diff = diffMarkdown(oldText, newText);

  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.moved.length, 0);
  assert.equal(diff.changed.length, 1);
  assert.deepEqual(diff.changed[0], {
    heading: "Setup",
    id: "setup",
    occurrence: 2,
    oldText: "# Setup\ntwo\n\n",
    oldRange: { start: 4, end: 6 },
    newText: "# Setup\ntwo changed\n\n",
    newRange: { start: 4, end: 6 },
  });
});

test("Setext headings are sections like ATX headings", () => {
  const oldText = "Title\n=====\n\nOld body.\n\nPart\n----\n\nMore.\n";
  const newText = "Title\n=====\n\nNew body.\n\nPart\n----\n\nMore.\n";
  const diff = diffMarkdown(oldText, newText);

  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.moved.length, 0);
  assert.deepEqual(diff.changed, [
    {
      heading: "Title",
      id: "title",
      occurrence: 1,
      oldText: "Title\n=====\n\nOld body.\n\n",
      oldRange: { start: 1, end: 5 },
      newText: "Title\n=====\n\nNew body.\n\n",
      newRange: { start: 1, end: 5 },
    },
  ]);
});

test("whitespace-only changes, including line endings, are ignored", () => {
  const oldText = "# A\n\nhello   world\nsecond line\n";
  const reflowed = "# A\n\nhello world second   line\n";
  const crlf = reflowed.replaceAll("\n", "\r\n");

  assert.deepEqual(diffMarkdown(oldText, reflowed), EMPTY);
  assert.deepEqual(diffMarkdown(oldText, crlf), EMPTY);
  assert.deepEqual(diffMarkdown("# A   B\nbody\n", "# A B\nbody\n"), EMPTY);
});

test("empty documents and whitespace-only documents have no sections", () => {
  assert.deepEqual(diffMarkdown("", ""), EMPTY);
  assert.deepEqual(diffMarkdown("\n\n", ""), EMPTY);
  assert.deepEqual(diffMarkdown("", "  \r\n\r\n"), EMPTY);
});

test("a heading added to an empty document is added, and removed the other way", () => {
  assert.deepEqual(diffMarkdown("", "# A\n"), {
    ...EMPTY,
    added: [
      {
        heading: "A",
        id: "a",
        occurrence: 1,
        newText: "# A\n",
        newRange: { start: 1, end: 1 },
      },
    ],
  });
  assert.deepEqual(diffMarkdown("# A\n", ""), {
    ...EMPTY,
    removed: [
      {
        heading: "A",
        id: "a",
        occurrence: 1,
        oldText: "# A\n",
        oldRange: { start: 1, end: 1 },
      },
    ],
  });
});

test("text before the first heading is a preamble and is not a section", () => {
  const oldText = "Old intro.\n\n# A\nbody\n";
  const newText = "New intro.\n\n# A\nbody\n";
  assert.deepEqual(diffMarkdown(oldText, newText), EMPTY);
});

test("a heading-like line inside a fenced code block is not a section", () => {
  const oldText = "# A\n\n```\n# Fake\n```\n";
  const newText = "# A\n\n```\n# Fake two\n```\n";
  const diff = diffMarkdown(oldText, newText);

  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.moved.length, 0);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0]?.heading, "A");
});

test("changing only a custom id's heading text is a change, not a remove and add", () => {
  const oldText = "# Old name {#stable}\nbody\n";
  const newText = "# New name {#stable}\nbody\n";
  const diff = diffMarkdown(oldText, newText);

  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.moved.length, 0);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0]?.heading, "New name");
  assert.equal(diff.changed[0]?.id, "stable");
  assert.equal(diff.changed[0]?.occurrence, 1);
});

test("added and removed sections keep document order, changed sections use the new order", () => {
  const reordered = diffMarkdown(
    "# C\nc\n\n# A\na\n",
    "# B\nb\n\n# D\nd\n\n# A\na\n",
  );
  assert.deepEqual(reordered.added.map((section) => section.heading), ["B", "D"]);
  assert.deepEqual(reordered.removed.map((section) => section.heading), ["C"]);

  const changed = diffMarkdown(
    "# B\nb\n\n# A\na\n",
    "# B\nb two\n\n# A\na two\n",
  );
  assert.deepEqual(changed.changed.map((section) => section.heading), ["B", "A"]);
});

test("the same two documents always produce the same diff", () => {
  const oldText = "# Keep\nsame\n\n# Eat\nold\n\n# Move\nmove\n\n# Gone\ngone\n";
  const newText = "# Move\nmove\n\n# Keep\nsame\n\n# Eat\nnew\n\n# Fresh\nfresh\n";

  const first = diffMarkdown(oldText, newText);
  const second = diffMarkdown(oldText, newText);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.added.map((section) => section.heading), ["Fresh"]);
  assert.deepEqual(first.removed.map((section) => section.heading), ["Gone"]);
  assert.deepEqual(first.changed.map((section) => section.heading), ["Eat"]);
  assert.deepEqual(first.moved.map((section) => section.heading), ["Move"]);
});
