# Rule artifacts-021

Reports when a manifest is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `info` |
| Limit | 88 |

## Fix

Change the manifest so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-021
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
