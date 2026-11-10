# Rule deploy-041

Reports when a token is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 35 |

## Fix

Change the token so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-041
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
