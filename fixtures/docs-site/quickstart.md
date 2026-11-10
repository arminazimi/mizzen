# Quickstart

Five commands take an empty folder to a published site.

## The first deploy

```bash
beacon init            # writes beacon.yml
beacon build           # runs the build command from beacon.yml
beacon deploy staging  # uploads the artifact and prints the URL
```

`beacon init` creates [beacon.yml](configuration.md), the only file Beacon reads besides your
credentials. A deploy writes an artifact, so `beacon rollback` and `beacon releases` stay in
[commands](commands.md).

## What happens next

Each deploy is recorded. Read [output](output.md) to know what the lines mean, or see the
[dashboard](dashboard/) for the last runs.
