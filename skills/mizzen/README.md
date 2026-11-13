# Mizzen Agent Skill

Use Mizzen's engine-development workflows from a compatible coding agent: pipeline and contract changes, deterministic outputs, exact source positions, CLI behavior, plugins, and safe span edits.

## Install

```bash
npx skills add velella-sh/mizzen --skill mizzen --yes
```

Update an existing installation:

```bash
npx skills update mizzen
```

## Example requests

- “Add a deterministic JSON output to Mizzen and test path collisions.”
- “Fix the source span in this Markdown diagnostic.”
- “Debug why `mizzen build --workers auto` is not byte-identical.”
- “Add a derived site fact with `_data` precedence.”

Lateen-only visual and component work belongs to the `lateen` Skill. Dependency lifecycle checks belong to Ebb or Offing.

## Package contents

The portable Skill is `SKILL.md`. The `evals/` folder contains its trigger corpus and is excluded from the npm package. There are no executable Skill scripts, credentials, hooks, or pre-approved tools.
