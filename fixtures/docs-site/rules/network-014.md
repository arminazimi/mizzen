# Rule network-014

Reports when a cache entry is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 43 |

## Fix

Change the cache entry so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule network-014
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
