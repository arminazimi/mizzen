# Configuration

`beacon.yml` sits at the root of the project. Every key is optional except `build`.

## Keys

- `build` — the command that produces the artifact.
- `publish` — the folder to upload, default `dist`.
- `environments` — a map of names to targets; `deploy` takes one of these names.
- `hooks` — commands that run before and after a deploy.

## Example

```yaml
build: npm run build
publish: dist
environments:
  staging:
    target: s3://beacon-staging
  production:
    target: s3://beacon-prod
    hooks:
      after: curl -fsS https://example.com/redeploy
```

Values resolve in this order: flags, then environment variables, then the file. Credentials are
covered in [security](security.md).
