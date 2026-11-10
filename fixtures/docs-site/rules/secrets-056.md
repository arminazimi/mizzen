# Rule secrets-056

Reports when a cache entry is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `warning` |
| Limit | 67 |

## Fix

Change the cache entry so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-056
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
