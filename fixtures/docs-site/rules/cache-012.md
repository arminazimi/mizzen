# Rule cache-012

Reports when a manifest is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `error` |
| Limit | 34 |

## Fix

Change the manifest so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-012
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
