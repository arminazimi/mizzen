# FAQ

## Can I use a different build tool?

Yes. `build` is any command that writes the `publish` folder.

## Does Beacon need a server?

No. It uploads artifacts to the target you name; see [install](install.md) for what the binary
depends on.

## Why is my deploy list empty?

`releases` reads the target, not a local cache — the same target must be configured in
[beacon.yml](configuration.md).

## Where is the full flag list?

In the [reference](reference/) section, one page per command.
