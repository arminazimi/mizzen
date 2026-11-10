# Rule deploy-001

Reports when a token is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `error` |
| Limit | 29 |

## Fix

Change the token so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-001
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
