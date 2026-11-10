# Rule build-010

Reports when a artifact points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `error` |
| Limit | 97 |

## Fix

Change the artifact so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule build-010
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
