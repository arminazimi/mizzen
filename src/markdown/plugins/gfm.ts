import remarkGfm from "remark-gfm";

/** Lowest order so GFM (tables, task lists, strikethrough, autolinks) runs first. */
export const name = "gfm";
export const order = 0;
export const plugin = remarkGfm;
