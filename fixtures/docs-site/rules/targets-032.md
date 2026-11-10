# Rule targets-032

Reports when a token is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `error` |
| Limit | 23 |

## Fix

Change the token so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-032
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
