# Rule deploy-050

Reports when a manifest is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `info` |
| Limit | 38 |

## Fix

Change the manifest so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-050
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
