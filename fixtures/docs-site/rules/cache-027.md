# Rule cache-027

Reports when a environment is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 26 |

## Fix

Change the environment so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-027
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
