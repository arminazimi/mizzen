# Rule artifacts-028

Reports when a manifest is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 88 |

## Fix

Change the manifest so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-028
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
