# Rule config-018

Reports when a artifact is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `warning` |
| Limit | 2 |

## Fix

Change the artifact so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule config-018
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
