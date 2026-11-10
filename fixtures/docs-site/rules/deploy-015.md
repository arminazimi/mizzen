# Rule deploy-015

Reports when a artifact is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `info` |
| Limit | 85 |

## Fix

Change the artifact so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-015
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
