import assert from "node:assert/strict";
import { test } from "node:test";
import type { NavItem } from "../src/contracts/nav.ts";
import { type FolderPage, navFromFolders } from "../src/nav/from-folders.ts";
import { navState } from "../src/nav/tree.ts";

function page(path: string, title: string, extra: Partial<FolderPage> = {}): FolderPage {
  const url = `/${path.replace(/(index|README)?\.md$/, "")}`;
  return { path, url, title, ...extra };
}

test("a folder with an index page becomes a group titled by that page, and the index is not a child", () => {
  const items = navFromFolders([
    page("guide/index.md", "Getting started"),
    page("guide/install.md", "Install"),
  ]);
  assert.deepEqual(items, [
    { title: "Getting started", children: [{ title: "Install", url: "/guide/install" }] },
  ]);
});

test("a folder without an index page is titled by its name", () => {
  const items = navFromFolders([page("reference/api.md", "API")]);
  assert.deepEqual(items, [
    { title: "reference", children: [{ title: "API", url: "/reference/api" }] },
  ]);
});

test("the top-level index page is the home page and is not listed", () => {
  const items = navFromFolders([
    page("index.md", "Home"),
    page("about.md", "About"),
  ]);
  assert.deepEqual(items, [{ title: "About", url: "/about" }]);
});

test("siblings sort by order first, with missing order last, then by title", () => {
  const items = navFromFolders([
    page("b.md", "Bravo"),
    page("a.md", "Alpha", { order: 2 }),
    page("c.md", "Charlie", { order: 1 }),
    page("d.md", "Delta"),
  ]);
  assert.deepEqual(items, [
    { title: "Charlie", url: "/c" },
    { title: "Alpha", url: "/a" },
    { title: "Bravo", url: "/b" },
    { title: "Delta", url: "/d" },
  ]);
});

test("a folder group sorts among pages by its index order", () => {
  const items = navFromFolders([
    page("intro.md", "Intro", { order: 5 }),
    page("guide/index.md", "Guide", { order: 1 }),
    page("guide/install.md", "Install"),
    page("zeta.md", "Zeta"),
  ]);
  assert.deepEqual(items.map((item) => item.title), ["Guide", "Intro", "Zeta"]);
});

test("titles compare by code point, not by locale", () => {
  const items = navFromFolders([page("a.md", "apple"), page("b.md", "Banana")]);
  assert.deepEqual(items.map((item) => item.title), ["Banana", "apple"]);
});

test("nested folders become nested groups", () => {
  const items = navFromFolders([
    page("guide/advanced/index.md", "Advanced"),
    page("guide/advanced/tuning.md", "Tuning"),
    page("guide/install.md", "Install"),
  ]);
  assert.deepEqual(items, [
    {
      title: "guide",
      children: [
        { title: "Advanced", children: [{ title: "Tuning", url: "/guide/advanced/tuning" }] },
        { title: "Install", url: "/guide/install" },
      ],
    },
  ]);
});

test("a folder that lists no pages, only its index, produces no group", () => {
  const items = navFromFolders([
    page("empty/index.md", "Empty"),
    page("about.md", "About"),
  ]);
  assert.deepEqual(items, [{ title: "About", url: "/about" }]);
});

test("a README counts as a folder index, like the permalink rule", () => {
  const items = navFromFolders([
    page("guide/README.md", "Guide home"),
    page("guide/install.md", "Install"),
  ]);
  assert.deepEqual(items, [
    { title: "Guide home", children: [{ title: "Install", url: "/guide/install" }] },
  ]);
});

test("no pages give an empty list", () => {
  assert.deepEqual(navFromFolders([]), []);
});

test("the built list feeds navState: the page is current, with its group in the trail and a pager", () => {
  const items: readonly NavItem[] = navFromFolders([
    page("guide/index.md", "Guide"),
    page("guide/install.md", "Install"),
    page("guide/write.md", "Write"),
  ]);
  const state = navState(items, "/guide/write");
  assert.equal(state.current?.title, "Write");
  assert.deepEqual(state.trail, [
    { title: "Guide", url: "/guide/install" },
    { title: "Write", url: "/guide/write" },
  ]);
  assert.deepEqual(state.pager, { prev: { title: "Install", url: "/guide/install" } });
});
