# Rule deploy-011

Reports when a artifact is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `info` |
| Limit | 61 |

## Fix

Change the artifact so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-011
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
