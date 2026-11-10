# Rule deploy-054

Reports when a token is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `error` |
| Limit | 69 |

## Fix

Change the token so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-054
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
