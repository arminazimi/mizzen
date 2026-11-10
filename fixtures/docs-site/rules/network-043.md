# Rule network-043

Reports when a cache entry is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 67 |

## Fix

Change the cache entry so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule network-043
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
