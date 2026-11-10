# Rule deploy-016

Reports when a target is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `info` |
| Limit | 44 |

## Fix

Change the target so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-016
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
