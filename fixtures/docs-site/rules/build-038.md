# Rule build-038

Reports when a cache entry is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `warning` |
| Limit | 13 |

## Fix

Change the cache entry so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule build-038
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
