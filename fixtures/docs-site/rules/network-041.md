# Rule network-041

Reports when a target points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 16 |

## Fix

Change the target so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule network-041
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
