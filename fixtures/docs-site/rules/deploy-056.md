# Rule deploy-056

Reports when a cache entry uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 5 |

## Fix

Change the cache entry so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-056
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
