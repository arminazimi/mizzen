# Reference

One page per command, written by `generate.mjs`. This section stands in for a
real product's generated reference: a page each, no front matter, and a table of contents
that stays in step with the pages.

| Command | What it does |
| --- | --- |
| [beacon init](./init.md) | writes beacon.yml |
| [beacon build](./build.md) | runs the build command |
| [beacon deploy](./deploy.md) | uploads an artifact and points an environment at it |
| [beacon releases](./releases.md) | lists the last artifacts |
| [beacon rollback](./rollback.md) | points an environment at an older artifact |
| [beacon status](./status.md) | prints what each environment serves |
| [beacon login](./login.md) | stores a token for later runs |
| [beacon logout](./logout.md) | forgets a stored token |
| [beacon targets](./targets.md) | lists configured targets |
| [beacon env](./env.md) | lists environments |
| [beacon config show](./config-show.md) | prints the resolved configuration |
| [beacon config set](./config-set.md) | writes one key to beacon.yml |
| [beacon config path](./config-path.md) | prints the file Beacon read |
| [beacon validate](./validate.md) | checks beacon.yml without touching a target |
| [beacon cache clear](./cache-clear.md) | drops the local build cache |
| [beacon cache ls](./cache-ls.md) | lists cached artifacts |
| [beacon logs](./logs.md) | streams the deploy log |
| [beacon secret set](./secret-set.md) | stores a secret for hooks |
| [beacon secret ls](./secret-ls.md) | lists secret names, never values |
| [beacon secret rm](./secret-rm.md) | deletes a secret |
| [beacon hook run](./hook-run.md) | runs one hook by hand |
| [beacon hook ls](./hook-ls.md) | lists configured hooks |
| [beacon size](./size.md) | reports the artifact size per file |
| [beacon diff](./diff.md) | compares two artifacts |
| [beacon purge](./purge.md) | removes old artifacts |
| [beacon doctor](./doctor.md) | checks the machine and the configuration |
| [beacon version](./version.md) | prints the version and build date |
| [beacon completion](./completion.md) | prints a shell completion script |
| [beacon help](./help.md) | prints help for any command |
