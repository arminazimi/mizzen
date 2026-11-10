# Rule network-008

Reports when a cache entry is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `warning` |
| Limit | 25 |

## Fix

Change the cache entry so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule network-008
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
