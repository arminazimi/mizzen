# Rule build-040

Reports when a hook is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `error` |
| Limit | 20 |

## Fix

Change the hook so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule build-040
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
