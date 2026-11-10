# Rule deploy-053

Reports when a artifact is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `error` |
| Limit | 27 |

## Fix

Change the artifact so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-053
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
