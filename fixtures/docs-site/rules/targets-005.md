# Rule targets-005

Reports when a token is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `info` |
| Limit | 75 |

## Fix

Change the token so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-005
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
