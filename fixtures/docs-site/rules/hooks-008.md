# Rule hooks-008

Reports when a cache entry is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `info` |
| Limit | 92 |

## Fix

Change the cache entry so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-008
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
