# Rule cache-040

Reports when a hook is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 24 |

## Fix

Change the hook so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-040
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
