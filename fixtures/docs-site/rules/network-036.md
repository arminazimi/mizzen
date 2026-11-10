# Rule network-036

Reports when a target is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 63 |

## Fix

Change the target so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule network-036
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
