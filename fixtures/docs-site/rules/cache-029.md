# Rule cache-029

Reports when a manifest is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 72 |

## Fix

Change the manifest so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-029
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
