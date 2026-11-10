# Rule build-029

Reports when a token points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `error` |
| Limit | 42 |

## Fix

Change the token so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule build-029
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
