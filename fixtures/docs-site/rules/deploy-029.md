# Rule deploy-029

Reports when a token points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 9 |

## Fix

Change the token so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-029
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
