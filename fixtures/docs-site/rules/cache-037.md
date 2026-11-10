# Rule cache-037

Reports when a hook is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 74 |

## Fix

Change the hook so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-037
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
