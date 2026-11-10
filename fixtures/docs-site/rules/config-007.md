# Rule config-007

Reports when a build step is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 30 |

## Fix

Change the build step so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule config-007
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
