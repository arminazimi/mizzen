# Rule deploy-017

Reports when a environment points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `info` |
| Limit | 22 |

## Fix

Change the environment so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-017
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
