# Rule targets-002

Reports when a target points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `error` |
| Limit | 86 |

## Fix

Change the target so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-002
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
