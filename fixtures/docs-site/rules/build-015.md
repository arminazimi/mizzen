# Rule build-015

Reports when a manifest is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `warning` |
| Limit | 84 |

## Fix

Change the manifest so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule build-015
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
