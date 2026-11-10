# Rule hooks-031

Reports when a environment points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 97 |

## Fix

Change the environment so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-031
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
