# Security

## Credentials

Beacon takes `BEACON_TOKEN` from the environment and never writes it to disk. A token is scoped to
one environment; production tokens live in the CI secret store.

## What Beacon touches

Uploads go to the target in `beacon.yml` and nowhere else. Hooks run with your user's permissions,
so keep them in the repository — the example in [configuration](configuration.md) is the shape most
teams keep.

## Reporting a problem

Open an issue on the repository with the output of `beacon status --json` with tokens redacted.
