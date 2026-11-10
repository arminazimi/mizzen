# Rule deploy-022

Reports when a cache entry is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 74 |

## Fix

Change the cache entry so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-022
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
