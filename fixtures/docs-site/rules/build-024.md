# Rule build-024

Reports when a hook is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `error` |
| Limit | 89 |

## Fix

Change the hook so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule build-024
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
