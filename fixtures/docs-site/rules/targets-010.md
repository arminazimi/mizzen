# Rule targets-010

Reports when a artifact is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 79 |

## Fix

Change the artifact so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-010
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
