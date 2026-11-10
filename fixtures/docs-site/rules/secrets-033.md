# Rule secrets-033

Reports when a cache entry is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 38 |

## Fix

Change the cache entry so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-033
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
