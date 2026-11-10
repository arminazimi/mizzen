# Rule cache-041

Reports when a artifact is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 91 |

## Fix

Change the artifact so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-041
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
