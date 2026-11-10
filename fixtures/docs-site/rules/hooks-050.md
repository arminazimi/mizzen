# Rule hooks-050

Reports when a hook is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `error` |
| Limit | 65 |

## Fix

Change the hook so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-050
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
