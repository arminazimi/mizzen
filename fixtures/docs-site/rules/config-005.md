# Rule config-005

Reports when a build step is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `warning` |
| Limit | 98 |

## Fix

Change the build step so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule config-005
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
