# Rule hooks-001

Reports when a token is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `error` |
| Limit | 59 |

## Fix

Change the token so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-001
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
