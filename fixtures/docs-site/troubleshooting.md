# Troubleshooting

## The upload times out

A cold cache uploads the whole artifact. Keep `publish` small and let the build cache warm between
runs; `beacon deploy --dry-run` prints the file count first.

## `error: no credentials`

Beacon reads `BEACON_TOKEN` before any file. In CI, the secret is scoped to the environment the job
uses — [security](security.md).

## A deploy succeeded but the site is old

`beacon status` compares what an environment serves with the newest artifact. When they differ,
`beacon rollback` is faster than a new deploy.

## The reference is slow to search

The [reference](reference/) section is generated; a page's title is the command name, so your
browser's find works per page and the site search covers the whole set.
