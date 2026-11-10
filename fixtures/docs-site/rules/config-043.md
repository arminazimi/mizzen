# Rule config-043

Reports when a manifest is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `error` |
| Limit | 87 |

## Fix

Change the manifest so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule config-043
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
