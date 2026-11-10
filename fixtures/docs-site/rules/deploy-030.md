# Rule deploy-030

Reports when a environment is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `info` |
| Limit | 58 |

## Fix

Change the environment so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-030
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
