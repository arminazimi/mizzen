# Rule config-037

Reports when a manifest is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `error` |
| Limit | 83 |

## Fix

Change the manifest so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule config-037
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
