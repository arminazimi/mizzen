# Rule network-001

Reports when a token is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `warning` |
| Limit | 67 |

## Fix

Change the token so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule network-001
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
