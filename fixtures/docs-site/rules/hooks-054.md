# Rule hooks-054

Reports when a token is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 23 |

## Fix

Change the token so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-054
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
