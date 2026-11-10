# Rule artifacts-041

Reports when a cache entry is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 56 |

## Fix

Change the cache entry so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-041
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
