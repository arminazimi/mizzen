# Rule artifacts-045

Reports when a token is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `info` |
| Limit | 91 |

## Fix

Change the token so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-045
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
