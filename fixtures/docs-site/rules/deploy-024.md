# Rule deploy-024

Reports when a release is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `info` |
| Limit | 28 |

## Fix

Change the release so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-024
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
