# Rule targets-014

Reports when a target is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 74 |

## Fix

Change the target so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-014
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
