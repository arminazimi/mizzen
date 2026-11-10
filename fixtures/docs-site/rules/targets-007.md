# Rule targets-007

Reports when a cache entry is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 82 |

## Fix

Change the cache entry so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-007
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
