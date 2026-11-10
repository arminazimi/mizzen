# Commands

The everyday set. Each command has its own page in the [reference](reference/).

| Command | What it does |
| --- | --- |
| `beacon init` | writes `beacon.yml` |
| `beacon build` | runs the build command |
| `beacon deploy` | uploads an artifact and points the environment at it |
| `beacon releases` | lists the last artifacts |
| `beacon rollback` | points an environment at an older artifact |
| `beacon status` | prints what each environment serves |

## Flags

`--env` selects an environment, `--dry-run` prints what would happen, and `--json` switches the
output; see [output format](output.md).
