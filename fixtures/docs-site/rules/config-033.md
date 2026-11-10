# Rule config-033

Reports when a artifact is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `warning` |
| Limit | 87 |

## Fix

Change the artifact so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule config-033
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
