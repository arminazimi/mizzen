# Rule cache-024

Reports when a build step is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 76 |

## Fix

Change the build step so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-024
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
