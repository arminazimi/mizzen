# Rule cache-031

Reports when a artifact is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 39 |

## Fix

Change the artifact so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-031
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
