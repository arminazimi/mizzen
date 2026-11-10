# Rule targets-018

Reports when a hook is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 91 |

## Fix

Change the hook so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-018
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
