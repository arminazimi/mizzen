# Rule config-010

Reports when a artifact is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 36 |

## Fix

Change the artifact so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule config-010
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
