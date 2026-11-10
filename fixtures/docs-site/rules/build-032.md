# Rule build-032

Reports when a release points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `warning` |
| Limit | 80 |

## Fix

Change the release so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule build-032
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
