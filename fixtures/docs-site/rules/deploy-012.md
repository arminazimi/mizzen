# Rule deploy-012

Reports when a environment is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `error` |
| Limit | 95 |

## Fix

Change the environment so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-012
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
