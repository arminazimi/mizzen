import assert from "node:assert/strict";
import { test } from "node:test";
import type { NavItem, NavLink } from "../src/contracts/nav.ts";
import { navState } from "../src/nav/tree.ts";

const install: NavLink = { title: "Install", url: "/guide/install/" };
const write: NavLink = { title: "Write", url: "/guide/write/" };
const publish: NavLink = { title: "Publish", url: "/guide/publish/" };
const reference: NavLink = { title: "Reference", url: "/reference/", match: "/reference/" };
const rules: NavLink = { title: "Rules", url: "/rules/", match: "/rules/" };

const docs: readonly NavItem[] = [
  { title: "Guide", children: [install, write, publish] },
  reference,
  rules,
];

test("a generated rule page marks the rules section, not every child", () => {
  // Large sections list one entry with `match`; the 500 rule pages are not in the tree.
  const state = navState(docs, "/rules/no-empty-alt/");
  assert.equal(state.active, rules);
  assert.equal(state.current, undefined);
  assert.deepEqual(state.trail, [rules]);
  assert.deepEqual(state.pager, {});
  assert.equal(docs.filter((item) => !("children" in item) && item.match === "/rules/").length, 1);
});

test("an exact url match is current and not active, even when match would cover it", () => {
  const state = navState(docs, "/rules/");
  assert.equal(state.current, rules);
  assert.equal(state.active, undefined);
  assert.deepEqual(state.trail, [rules]);
});

test("pager follows reading order of leaves", () => {
  assert.deepEqual(navState(docs, "/guide/install/").pager, { next: write });
  assert.deepEqual(navState(docs, "/guide/write/").pager, { prev: install, next: publish });
  assert.deepEqual(navState(docs, "/guide/publish/").pager, { prev: write, next: reference });
  assert.deepEqual(navState(docs, "/reference/").pager, { prev: publish, next: rules });
  assert.deepEqual(navState(docs, "/rules/").pager, { prev: reference });
});

test("breadcrumb for a page under a group includes the group as a section link", () => {
  const state = navState(docs, "/guide/write/");
  assert.equal(state.current, write);
  assert.deepEqual(state.trail, [
    { title: "Guide", url: "/guide/install/" },
    write,
  ]);
});

test("breadcrumb for a page whose leaf has match uses that match as the group url", () => {
  const leaf: NavLink = { title: "Install", url: "/example/guide/install/", match: "/example/guide/" };
  const items: readonly NavItem[] = [{ title: "Guide", children: [leaf] }];
  const state = navState(items, leaf.url);
  assert.deepEqual(state.trail, [{ title: "Guide", url: "/example/guide/" }, leaf]);
});

test("match observes path segment boundaries", () => {
  assert.equal(navState([rules], "/ruleset/x/").active, undefined);
  assert.equal(navState([{ title: "Rules", url: "/rules/", match: "/rules" }], "/rules/x/").active?.title, "Rules");
  assert.equal(navState([{ title: "Rules", url: "/rules/", match: "/rules" }], "/rules").active?.title, "Rules");
});

test("the longest matching match wins when prefixes nest", () => {
  const short: NavLink = { title: "Docs", url: "/docs/", match: "/docs/" };
  const long: NavLink = { title: "API", url: "/docs/api/", match: "/docs/api/" };
  const state = navState([short, long], "/docs/api/widgets/");
  assert.equal(state.active, long);
});

test("a page outside the tree has an empty trail and pager", () => {
  assert.deepEqual(navState(docs, "/elsewhere/"), {
    trail: [],
    pager: {},
  });
});
