# Rule targets-006

Reports when a token is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 98 |

## Fix

Change the token so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-006
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
