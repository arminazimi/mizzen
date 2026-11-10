# Rule targets-011

Reports when a manifest is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `info` |
| Limit | 71 |

## Fix

Change the manifest so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-011
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
