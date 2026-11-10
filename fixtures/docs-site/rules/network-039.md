# Rule network-039

Reports when a cache entry is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 44 |

## Fix

Change the cache entry so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule network-039
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
