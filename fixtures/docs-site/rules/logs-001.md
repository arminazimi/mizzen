# Rule logs-001

Reports when a cache entry is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 77 |

## Fix

Change the cache entry so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-001
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
