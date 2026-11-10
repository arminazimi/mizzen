# Rule config-027

Reports when a build step is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 94 |

## Fix

Change the build step so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule config-027
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
