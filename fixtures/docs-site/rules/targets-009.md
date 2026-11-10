# Rule targets-009

Reports when a build step is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 45 |

## Fix

Change the build step so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-009
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
