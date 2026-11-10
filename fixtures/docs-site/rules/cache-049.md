# Rule cache-049

Reports when a manifest is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `error` |
| Limit | 16 |

## Fix

Change the manifest so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-049
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
