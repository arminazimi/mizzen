# Rule config-034

Reports when a artifact is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 64 |

## Fix

Change the artifact so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule config-034
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
