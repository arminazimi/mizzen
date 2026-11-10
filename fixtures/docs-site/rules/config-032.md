# Rule config-032

Reports when a cache entry is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `error` |
| Limit | 46 |

## Fix

Change the cache entry so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule config-032
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
