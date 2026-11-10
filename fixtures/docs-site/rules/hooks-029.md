# Rule hooks-029

Reports when a hook is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 67 |

## Fix

Change the hook so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-029
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
