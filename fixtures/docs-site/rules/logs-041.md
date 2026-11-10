# Rule logs-041

Reports when a cache entry is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `info` |
| Limit | 57 |

## Fix

Change the cache entry so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-041
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
