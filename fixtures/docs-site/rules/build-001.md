# Rule build-001

Reports when a manifest is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `error` |
| Limit | 19 |

## Fix

Change the manifest so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule build-001
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
