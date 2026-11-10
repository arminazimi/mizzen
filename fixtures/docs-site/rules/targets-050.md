# Rule targets-050

Reports when a token is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `error` |
| Limit | 38 |

## Fix

Change the token so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-050
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
