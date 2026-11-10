# Rule network-038

Reports when a target points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 69 |

## Fix

Change the target so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule network-038
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
