# Rule artifacts-023

Reports when a artifact is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 90 |

## Fix

Change the artifact so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-023
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
