# Rule cache-061

Reports when a artifact is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 68 |

## Fix

Change the artifact so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-061
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
