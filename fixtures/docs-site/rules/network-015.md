# Rule network-015

Reports when a build step is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 56 |

## Fix

Change the build step so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule network-015
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
