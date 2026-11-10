# Rule deploy-057

Reports when a environment is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `info` |
| Limit | 12 |

## Fix

Change the environment so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-057
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
