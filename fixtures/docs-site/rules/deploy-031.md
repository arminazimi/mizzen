# Rule deploy-031

Reports when a artifact is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `error` |
| Limit | 42 |

## Fix

Change the artifact so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-031
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
