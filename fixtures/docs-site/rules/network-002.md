# Rule network-002

Reports when a token is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 79 |

## Fix

Change the token so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule network-002
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
