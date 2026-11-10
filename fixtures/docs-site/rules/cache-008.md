# Rule cache-008

Reports when a cache entry points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `error` |
| Limit | 89 |

## Fix

Change the cache entry so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-008
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
