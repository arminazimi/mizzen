# Rule hooks-021

Reports when a cache entry is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 32 |

## Fix

Change the cache entry so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-021
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
