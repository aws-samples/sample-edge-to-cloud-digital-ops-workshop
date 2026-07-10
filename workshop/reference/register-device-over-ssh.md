# Registering a Device over SSH

This guide covers [`scripts/register-device-ssh.sh`](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/scripts/register-device-ssh.sh),
which registers a device you bring — a Raspberry Pi, a spare Linux box, a VM — into your
workshop slot over SSH. It runs the same **fleet-provisioning-by-claim** flow the 3 workshop
EC2 instances use ([Session 1, Block 0](../01-observe/block-0-fleet-provisioning.md)), but
driven from your laptop against a device that has no EC2 identity.

## Where the work happens

The script runs on **your machine** with **your AWS credentials**. It opens an SSH connection
to the device and runs the build and install steps **on the device** — the AWS IoT Device
Client is a compiled C++ binary, so building it on the device guarantees the binary matches
the device's CPU architecture, libc, and OpenSSL version with no cross-compilation.

| Step | Runs on | Why |
|---|---|---|
| Fetch claim cert from Secrets Manager | Your laptop | Needs your AWS credentials |
| Describe the IoT data endpoint | Your laptop | Needs your AWS credentials |
| Build the Device Client | **The device** (over SSH) | Native arch / libc / OpenSSL match |
| Install claim cert + config + systemd unit | **The device** (over SSH) | Where the client runs |
| Verify the Thing appears | Your laptop | Reads the IoT registry |

!!! info "The device never holds AWS credentials"
    The device's only secret is the **claim certificate**, whose IoT policy is scoped to the
    provisioning topics. The device uses it once to self-provision, and IoT Core mints it a
    unique per-device certificate with the real device policy. Your AWS credentials stay on
    your laptop.

## Prerequisites

- Your laptop: AWS credentials for the workshop account, plus `ssh`, `scp`, `python3`.
- The device: reachable over SSH, a user with passwordless `sudo` (or root), **systemd**,
  **OpenSSL ≥ 1.1**, and outbound internet access (to `apt`/`dnf`/`apk`, GitHub, and the
  Amazon root CA). Your workshop slot (`ws-slot00`) already deployed and its claim cert
  present in Secrets Manager.

## Quick start

```bash
./scripts/register-device-ssh.sh \
  --ssh pi@raspberrypi.local \
  --deployment-id ws-slot00 \
  --thing-name my-pi-01
```

??? example "View source — arguments and usage"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/scripts/register-device-ssh.sh){ .md-button target=_blank }

    ```bash
    --8<-- "scripts/register-device-ssh.sh:usage"
    ```

If you omit `--thing-name`, the script derives one from the device's hostname
(`device-<hostname>`). Pass `-i <key>` for an SSH identity file, or `--ssh-opt "..."` to add
any other `ssh`/`scp` option (e.g. `--ssh-opt "-o StrictHostKeyChecking=no"` for a first
connection to a fresh device).

!!! tip "Registering an EC2 instance? Use SSM Session Manager instead of a public IP"
    If the "device" is an EC2 instance, you don't need to open port 22 or give it a public IP —
    tunnel SSH through **SSM Session Manager**. This works for any instance that has the SSM
    agent running and an instance-profile role with `AmazonSSMManagedInstanceCore` (the workshop
    EC2 instances already do).

    **1. Install the Session Manager plugin** (once) and confirm the instance is reachable:

    ```bash
    aws ssm describe-instance-information \
      --filters "Key=InstanceIds,Values=i-0123456789abcdef0" \
      --region us-east-1
    ```

    **2. Add an SSH `ProxyCommand` for instance IDs** to `~/.ssh/config`:

    ```
    host i-* mi-*
        ProxyCommand sh -c "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p' --region us-east-1"
    ```

    **3. Install your public key on the instance.** SSM tunnels the *connection*, but SSH still
    authenticates with a key at the far end — so your public key must be in the login user's
    `authorized_keys`, or you'll get `Permission denied (publickey)`. Push it once over SSM Run
    Command (no port 22, no keypair juggling). This also prints the correct login user (uid 1000):

    ```bash
    PUBKEY=$(cat ~/.ssh/id_ed25519.pub)   # your public key
    aws ssm send-command \
      --instance-ids i-0123456789abcdef0 \
      --region us-east-1 \
      --document-name AWS-RunShellScript \
      --parameters commands="[\"U=\$(getent passwd 1000 | cut -d: -f1); H=\$(getent passwd \$U | cut -d: -f6); install -d -m 700 -o \$U -g \$U \$H/.ssh; grep -qxF '$PUBKEY' \$H/.ssh/authorized_keys 2>/dev/null || echo '$PUBKEY' >> \$H/.ssh/authorized_keys; chmod 600 \$H/.ssh/authorized_keys; chown \$U:\$U \$H/.ssh/authorized_keys; echo LOGIN_USER=\$U\"]" \
      --query 'Command.CommandId' --output text
    ```

    Read the result with `aws ssm get-command-invocation --command-id <id> --instance-id
    i-0123456789abcdef0 --region us-east-1 --query StandardOutputContent --output text` — the
    `LOGIN_USER=...` line tells you the user for the next step.

    **4. Point `--ssh` at the instance ID** (SSH resolves it through the tunnel), using the login
    user from step 3:

    ```bash
    ./scripts/register-device-ssh.sh \
      --ssh admin@i-0123456789abcdef0 \
      -i ~/.ssh/id_ed25519 \
      --deployment-id ws-slot00 \
      --thing-name my-ec2-device
    ```

    The script's `ssh`/`scp` calls both traverse the tunnel, so the build and cert-install steps
    run on the instance exactly as they would over a normal SSH connection. Use the login user for
    the AMI: **`admin`** on Debian, `ec2-user` on Amazon Linux, `ubuntu` on Ubuntu (step 3 prints
    the actual one). To open a plain interactive shell without SSH, `aws ssm start-session --target
    i-0123456789abcdef0 --region us-east-1`.

---

## Targeting different OS stacks

The script's default build targets **Raspberry Pi OS / Debian / Ubuntu (arm64 or x86-64)**.
Everything except the **package-install line** is distro-agnostic, so adapting to another OS
means changing that one line.

??? example "View source — build the Device Client on the device"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/scripts/register-device-ssh.sh){ .md-button target=_blank }

    ```bash
    --8<-- "scripts/register-device-ssh.sh:build-device-client"
    ```

To register a device on a different stack, change only the install command:

| OS stack | Install command |
|---|---|
| Raspberry Pi OS / Debian / Ubuntu — *default* | `sudo apt-get install -y cmake gcc g++ libssl-dev libcurl4-openssl-dev git make` |
| Amazon Linux 2023 / RHEL / Fedora / Rocky | `sudo dnf install -y cmake gcc gcc-c++ openssl-devel libcurl-devel git make` |
| Alpine | `sudo apk add cmake g++ openssl-dev curl-dev git make` |
| SUSE / openSUSE | `sudo zypper install -y cmake gcc gcc-c++ libopenssl-devel libcurl-devel git make` |

**The rule:** build on the same OS/arch family the binary will run on — the package names
change, but the build is otherwise identical because it runs on the device.

!!! warning "Two constraints that aren't about the package manager"
    - **OpenSSL ≥ 1.1.** IoT Device Client v1.10.1 requires it. Raspberry Pi OS Bookworm and
      Amazon Linux 2023 ship OpenSSL 3.x and are fine. **Amazon Linux 2 ships OpenSSL 1.0.2**
      and needs extra cmake flags (see how [`scripts/sandbox.sh`](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/scripts/sandbox.sh)
      builds in an `amazonlinux:2023` container) — avoid AL2 for this script.
    - **systemd.** The client is installed as a systemd service. Mainstream server distros
      (Debian, Ubuntu, AL2023, RHEL, Fedora) use systemd; a minimal image without it needs a
      different init.

!!! tip "Already have a binary?"
    Pass `--skip-build` to reuse an `aws-iot-device-client` already on the device instead of
    compiling. Useful if you build once and image many identical devices.

---

## Example: registering a Raspberry Pi

A worked end-to-end flow for a Pi 4 running Raspberry Pi OS (Bookworm, 64-bit).

**1. Confirm you can reach the Pi over SSH.**

```bash
ssh pi@raspberrypi.local 'uname -m && . /etc/os-release && echo "$PRETTY_NAME"'
# aarch64
# Debian GNU/Linux 12 (bookworm)
```

`aarch64` + Debian 12 is the default target — no edits needed.

**2. Run the registration script from your laptop.**

```bash
./scripts/register-device-ssh.sh \
  --ssh pi@raspberrypi.local \
  --deployment-id ws-slot00 \
  --thing-name well-pad-pi-01
```

What you'll see, in order:

```
>>> Fetching claim certificate for ws-slot00 from Secrets Manager...
>>> IoT endpoint: a32ohwnx3y9mv7-ats.iot.us-east-1.amazonaws.com
>>> Registering Thing: well-pad-pi-01
>>> Building aws-iot-device-client v1.10.1 on the device (~8 min)...
>>> built: v1.10.1
>>> Writing claim certificate and device-client config on the device...
>>> Service state: active
>>> Waiting for 'well-pad-pi-01' to appear in the IoT registry (up to 120s)...
>>> ✓ Registered: well-pad-pi-01 is now a Thing in ws-slot00.
```

The build takes roughly 8–15 minutes on Pi-class hardware (it's a full C++ compile of the
AWS IoT SDK). On a faster host it's a few minutes.

**3. Verify on the Pi.**

```bash
ssh pi@raspberrypi.local 'systemctl is-active aws-iot-device-client'
# active
ssh pi@raspberrypi.local 'sudo tail -20 /var/log/aws-iot-device-client.log'
# ... Successfully provisioned thing: well-pad-pi-01
# ... MQTT connection established with return code: 0
```

**4. Verify in AWS.**

```bash
aws iot describe-thing --thing-name well-pad-pi-01
aws iot list-things-in-thing-group --thing-group-name ws-slot00-devices
```

Your Pi now appears in the `ws-slot00-devices` group alongside the workshop's own devices,
with the `deploymentId` attribute set — so fleet-indexing queries and IoT Jobs targeting the
group reach it too.

### How the cert and config land on the device

Under the hood, step 2 splits the claim cert out of the Secrets Manager payload, copies it to
the device, and writes the Device Client config with a `fleet-provisioning` block keyed to
your slot's template:

??? example "View source — push claim cert and write config"
    [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/scripts/register-device-ssh.sh){ .md-button target=_blank }

    ```bash
    --8<-- "scripts/register-device-ssh.sh:provision"
    ```

---

## Security notes

- **The claim cert is a shared secret.** Because the workshop's pre-provisioning hook is
  log-only, any holder of the claim cert can register a device into the slot. Only deliver it
  to a device over SSH from your own machine — never commit it, and never paste it into a
  shared channel. In production you would keep the hook enforcing (validate the device against
  a registry) and/or use provisioning-by-trusted-user for a per-device audit trail
  ([Block 0](../01-observe/block-0-fleet-provisioning.md#trusted-user-the-production-ready-alternative)).
- **The private key never leaves the device unnecessarily.** The claim key is written with
  `0600` and the per-device key IoT mints during provisioning stays on the device.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `cmake: not found` / build fails immediately | Wrong package-install line for the OS | Use the correct row from the OS table above |
| Build fails linking `libcrypto`/`libssl` | OpenSSL < 1.1 (e.g. Amazon Linux 2) | Use an OpenSSL 3.x OS, or add explicit `OPENSSL_*_LIBRARY` cmake flags |
| Service `active` but Thing never appears | Claim cert/policy issue, or wrong `--deployment-id` | `sudo tail -50 /var/log/aws-iot-device-client.log` on the device |
| `Permission denied (publickey)` | SSH auth | Pass `-i <key>`, or the correct `user@host` |
| `sudo: a password is required` | No passwordless sudo | Run as a sudo-capable user or configure NOPASSWD |

## See also

- [Session 1, Block 0 — Fleet Provisioning](../01-observe/block-0-fleet-provisioning.md)
- [Session 2, Block 1 — IoT Device Client Architecture](../02-control/block-1-device-client.md)
