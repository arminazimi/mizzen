# Rule hooks-007

Reports when a token is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 94 |

## Fix

Change the token so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-007
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
