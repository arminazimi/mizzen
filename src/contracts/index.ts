/** The package's type-only surface: every contract a consumer may import, re-exported from its own module. */
export type { SourcePos } from "./source.ts";
export type { Diagnostic, DiagnosticFix, Severity } from "./diagnostic.ts";
export type { DefaultsEntry, Direction, LanguageConfig, RepositoryConfig, SearchConfig, SiteConfig, ThemeConfig } from "./config.ts";
export type { AgentInstructions, FrontMatter, Heading, Page, PageKind, PageStatus, Site } from "./content.ts";
export type { NavGroup, NavItem, NavLink, NavTree, Pager, Trail } from "./nav.ts";
export type { Output, OutputContext, OutputFile } from "./output.ts";
export type { Chrome, ChromeProps, Component, ComponentProps, Head, Island, Layout, LayoutProps, LinkTag, MetaTag, RenderNode } from "./render.ts";
export type { CodeConfig, MaybePromise, Plugin, PluginHooks } from "./plugin.ts";
export type { ContextConstraints, ContextRequest, ContextRequestProblem, ContextRequestResult, EvidenceRequirement, TaskIntent, TaskKind, TokenBudget, VersionRange } from "./context-request.ts";
