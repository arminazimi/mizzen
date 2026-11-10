# Rule deploy-043

Reports when a release is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `error` |
| Limit | 43 |

## Fix

Change the release so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-043
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
