# Rule build-017

Reports when a manifest is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `info` |
| Limit | 46 |

## Fix

Change the manifest so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule build-017
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
