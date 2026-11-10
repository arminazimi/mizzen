# Rule artifacts-026

Reports when a release is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 82 |

## Fix

Change the release so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-026
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
