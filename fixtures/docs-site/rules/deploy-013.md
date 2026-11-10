# Rule deploy-013

Reports when a hook is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `error` |
| Limit | 82 |

## Fix

Change the hook so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-013
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
