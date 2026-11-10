# Rule config-002

Reports when a artifact is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `warning` |
| Limit | 52 |

## Fix

Change the artifact so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule config-002
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
