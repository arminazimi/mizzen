# Rule targets-017

Reports when a manifest is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 22 |

## Fix

Change the manifest so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-017
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
