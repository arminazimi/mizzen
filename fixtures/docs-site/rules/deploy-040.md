# Rule deploy-040

Reports when a hook is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `info` |
| Limit | 88 |

## Fix

Change the hook so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-040
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
