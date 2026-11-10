# Rule config-030

Reports when a manifest is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 92 |

## Fix

Change the manifest so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule config-030
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
