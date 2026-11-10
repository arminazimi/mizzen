# Rule deploy-014

Reports when a manifest is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `error` |
| Limit | 16 |

## Fix

Change the manifest so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-014
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
