# Rule deploy-045

Reports when a hook is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `info` |
| Limit | 53 |

## Fix

Change the hook so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-045
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
