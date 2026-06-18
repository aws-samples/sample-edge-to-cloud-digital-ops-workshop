# Block 0 — Fleet Provisioning: How Devices Get Into IoT Core

**Duration:** 45 min  
**Type:** Conceptual walkthrough + console tour. No live provisioning — the 3 devices are already registered.

---

## The Four Provisioning Approaches

| Approach | Who owns the CA | When does the device get its permanent cert | Best for |
|---|---|---|---|
| **Single-thing / manual** | AWS IoT CA | Before the device ships | Lab devices, one-offs |
| **Provisioning by trusted user** | AWS IoT CA | At commissioning time — authenticated actor calls the API on demand | Any scale; natural fit when a commissioning workflow already exists |
| **Provisioning by claim** | AWS IoT CA | On first cloud connection — device exchanges a shared claim cert for a permanent cert | Automated deployments; no human commissioning step |
| **JITP / JITR** | **You own the CA** — cert signed by your PKI | Before the device ships — burned in at the factory | Hardware with factory-provisioned identity (HSM, secure enclave) |

!!! tip "The sharpest distinction"
    By-claim and JITP/JITR both look like "device self-registers on first connection," but they differ fundamentally. With **by-claim** the device arrives as a blank slate and AWS mints its identity on first boot. With **JITP/JITR** the device already holds its permanent identity from the factory floor — AWS just learns about it when it first connects.

---

## Claim Flow Walkthrough

This is what happened when the CDK stack deployed the 3 devices:

1. **CDK creates a provisioning template** ([`participant-stack.ts`](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/amplify/custom/participant-stack.ts)) — defines what IoT resources to create when a device presents a claim cert (Thing name derived from EC2 instance ID, policy attached, permanent cert activated)

    ??? example "View CDK source — provisioning template"
        [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/amplify/custom/participant-stack.ts){ .md-button target=_blank }

        ```typescript
        --8<-- "amplify/custom/participant-stack.ts:provisioning-template"
        ```

2. **CDK creates a claim certificate** — a shared credential with a tightly scoped IoT policy: can only connect and call `$aws/certificates/create/*` and `$aws/provisioning-templates/{templateName}/provision/*`
3. **CDK stores the claim cert in Secrets Manager** — scoped to the deployment. EC2 instances use an IAM instance profile with `secretsmanager:GetSecretValue` restricted to that specific secret ARN

    !!! warning "Why not user data?"
        EC2 user data is readable in plaintext by anyone with `ec2:DescribeInstanceAttribute` — effectively not secret. Secrets Manager provides fine-grained access control and CloudTrail audit logging.

4. **On first boot:** the user data script calls `aws secretsmanager get-secret-value`, writes the claim cert to disk, and starts the Device Client. The Device Client calls `CreateKeysAndCertificate` → `RegisterThing` → IoT Core creates the Thing and issues a permanent cert
5. **Claim cert files are deleted** immediately after `RegisterThing` succeeds
6. **Pre-provisioning hook Lambda** validates the request before IoT Core acts — rejects duplicate registrations and verifies the requesting instance exists in EC2 with the expected deployment tags

    ??? example "View CDK source — pre-provisioning hook"
        [:simple-github: Open in GitHub](https://github.com/aws-samples/sample-edge-to-cloud-digital-ops-workshop/blob/main/amplify/custom/participant-stack.ts){ .md-button target=_blank }

        ```typescript
        --8<-- "amplify/custom/participant-stack.ts:pre-provision-hook"
        ```

    !!! info "Teaching point"
        The specific hook logic matters less than the pattern. A shared claim cert is a wide key — any holder can attempt provisioning. The pre-hook is where you narrow that surface: verify the device is known to some authoritative source (EC2 tags, device registry, manufacturing database).

---

## Trusted User — The Production-Ready Alternative

**Provisioning by trusted user** maps directly onto the Cognito user pool already deployed in this workshop:

1. Field engineer authenticates to the management UI via Cognito
2. AppSync mutation → Lambda calls `CreateProvisioningClaim` via IoT management API
3. A **one-time-use** claim cert is returned and handed to the device
4. Device runs the same `RegisterThing` flow

| | By claim | By trusted user |
|---|---|---|
| Human required at install | No | Yes — authenticated via Cognito |
| Per-provisioning audit trail | No (shared cert) | Yes — Cognito identity + CloudTrail per device |
| Risk surface | Shared static cert must be kept secret | No shared secret; risk isolated to individual accounts |
| Works without cloud at factory | Yes | No — needs live API call |
| Fits this workshop's Cognito pool | No | **Yes — directly** |

By-claim is used here purely because the CDK deployment is fully automated with no human commissioning step.

---

## Console Tour

Open each link and walk through what's shown:

- [**IoT Core → Connect → Fleet Provisioning**](https://console.aws.amazon.com/iot/home#/provisioningtemplatehub) → show the provisioning template JSON
- [**IoT Core → Security → Certificates**](https://console.aws.amazon.com/iot/home#/certificatehub) → show the claim cert (status: `ACTIVE`, policy: provisioning-only)
- [**IoT Core → Manage → Things**](https://console.aws.amazon.com/iot/home#/thinghub) → open one device → show its permanent cert and attached policy
- [**IoT Core → Security → Policies**](https://console.aws.amazon.com/iot/home#/policyhub) → compare the claim cert policy (3 statements) vs the device operational policy (publish/subscribe on `edge/{DEPLOYMENT_ID}/#` and shadow topics)

---

## References

- [Fleet Provisioning by claim](https://docs.aws.amazon.com/iot/latest/developerguide/provision-wo-cert.html)
- [Provisioning by trusted user](https://docs.aws.amazon.com/iot/latest/developerguide/provision-wo-cert.html#trusted-user)
- [Pre-provisioning hooks](https://docs.aws.amazon.com/iot/latest/developerguide/pre-provisioning-hook.html)
- [Fleet provisioning template reference](https://docs.aws.amazon.com/iot/latest/developerguide/provision-template.html)
