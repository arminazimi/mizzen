# Rule targets-042

Reports when a environment is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 22 |

## Fix

Change the environment so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-042
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
