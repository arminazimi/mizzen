# Rule cache-030

Reports when a target points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `error` |
| Limit | 27 |

## Fix

Change the target so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-030
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
