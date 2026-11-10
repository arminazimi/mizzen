# Rule cache-017

Reports when a hook is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `error` |
| Limit | 35 |

## Fix

Change the hook so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-017
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
