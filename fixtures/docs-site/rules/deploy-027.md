# Rule deploy-027

Reports when a environment is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 67 |

## Fix

Change the environment so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-027
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
