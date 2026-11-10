# Rule config-014

Reports when a release is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 86 |

## Fix

Change the release so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule config-014
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
