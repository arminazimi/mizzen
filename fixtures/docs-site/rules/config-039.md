# Rule config-039

Reports when a manifest is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `error` |
| Limit | 65 |

## Fix

Change the manifest so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule config-039
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
