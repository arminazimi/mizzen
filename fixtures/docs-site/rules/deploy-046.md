# Rule deploy-046

Reports when a manifest is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `error` |
| Limit | 7 |

## Fix

Change the manifest so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-046
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
