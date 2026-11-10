# CI integration

Run Beacon in any pipeline that can cache a binary.

## GitHub Actions

```yaml
- run: beacon deploy production --json | tee beacon.json
```

`--json` keeps logs machine-readable; parse `url` and put it in the job summary.

## Rules that hold everywhere

- Keep credentials in the secret store, never in `beacon.yml` — see [security](security.md).
- Deploy on merge to the default branch only, so a rollback stays a one-command fix
  ([commands](commands.md)).
- Print `beacon status` after a failure; it is the shortest path to
  [troubleshooting](troubleshooting.md).
