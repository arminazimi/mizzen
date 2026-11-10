# Rule artifacts-006

Reports when a manifest is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 57 |

## Fix

Change the manifest so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-006
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
