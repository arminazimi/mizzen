# Rule cache-020

Reports when a build step is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 20 |

## Fix

Change the build step so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-020
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
