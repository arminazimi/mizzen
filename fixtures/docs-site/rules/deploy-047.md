# Rule deploy-047

Reports when a manifest is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `error` |
| Limit | 19 |

## Fix

Change the manifest so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-047
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
