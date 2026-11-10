# Rule config-046

Reports when a manifest is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 58 |

## Fix

Change the manifest so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule config-046
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
