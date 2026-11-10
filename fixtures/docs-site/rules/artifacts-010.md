# Rule artifacts-010

Reports when a token is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `info` |
| Limit | 38 |

## Fix

Change the token so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-010
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
