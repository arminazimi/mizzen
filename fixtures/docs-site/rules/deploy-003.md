# Rule deploy-003

Reports when a artifact is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 74 |

## Fix

Change the artifact so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-003
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
