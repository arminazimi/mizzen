# Rule hooks-055

Reports when a cache entry is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `info` |
| Limit | 54 |

## Fix

Change the cache entry so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-055
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
