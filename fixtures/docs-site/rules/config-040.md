# Rule config-040

Reports when a target is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 48 |

## Fix

Change the target so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule config-040
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
