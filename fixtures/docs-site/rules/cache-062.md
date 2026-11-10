# Rule cache-062

Reports when a artifact is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 66 |

## Fix

Change the artifact so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-062
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
