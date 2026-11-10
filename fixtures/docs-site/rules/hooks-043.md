# Rule hooks-043

Reports when a manifest is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 87 |

## Fix

Change the manifest so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-043
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
