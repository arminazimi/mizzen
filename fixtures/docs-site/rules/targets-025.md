# Rule targets-025

Reports when a manifest is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 30 |

## Fix

Change the manifest so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-025
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
