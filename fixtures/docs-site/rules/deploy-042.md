# Rule deploy-042

Reports when a manifest is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `error` |
| Limit | 68 |

## Fix

Change the manifest so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-042
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
