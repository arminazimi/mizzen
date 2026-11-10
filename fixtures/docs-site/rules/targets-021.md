# Rule targets-021

Reports when a target is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `info` |
| Limit | 3 |

## Fix

Change the target so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-021
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
