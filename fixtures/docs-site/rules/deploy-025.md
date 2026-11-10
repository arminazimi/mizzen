# Rule deploy-025

Reports when a hook is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `error` |
| Limit | 4 |

## Fix

Change the hook so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-025
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
