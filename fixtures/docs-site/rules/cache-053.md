# Rule cache-053

Reports when a cache entry is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 59 |

## Fix

Change the cache entry so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-053
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
