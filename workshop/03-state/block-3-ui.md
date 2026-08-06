# Block 3 — Front-End UI Walkthrough

**Duration:** 60 min

---

## First-Time Setup

Create a Cognito user for the workshop:

```bash
./scripts/create-workshop-user.sh --deployment-id ws-slot00 --username participant@example.com --password 'ChangeMe1!'
```
<!-- e2e:assert {"contains": "Workshop login credentials"} -->

`--username` and `--password` are both optional. If you omit `--username`, it defaults to `participant@<deployment-id>.workshop.local`. If you omit `--password`, the script generates a strong random password and prints it — there is no default password.

!!! note "Cognito password policy"
    Whatever password you supply (or the generated one) must satisfy the User Pool's password policy: minimum 8 characters, with at least one uppercase letter, one lowercase letter, one number, and one symbol.

Load the Amplify-hosted URL and sign in with the username and password printed under "Workshop login credentials".

---

## Device Fleet Page

Shows all 3 devices with live shadow state (last heartbeat, CPU, mem, disk, config version).

**Two data delivery patterns run simultaneously:**

| Pattern | How it works | Lambda involvement |
|---|---|---|
| **On-demand (page load / manual refresh)** | AppSync GraphQL query → Lambda resolver → IoT Device Shadow REST API | Lambda invoked once per request, then stops |
| **Live push (shadow changes while page is open)** | IoT Rule → Lambda → HTTP POST to AppSync Events API → browser WebSocket subscriber | Lambda invoked once per shadow change event; not once per subscriber |

!!! info "AppSync Events live update path"
    Lambda is invoked exactly **once per shadow change event**, not once per subscriber and not once per second of open connection. A user keeping the browser open all day costs zero ongoing Lambda invocations.

    1. IoT Rule detects shadow update → triggers Lambda
    2. Lambda POSTs to `https://{HTTP_DOMAIN}/event` (one HTTP call, Lambda exits)
    3. AppSync broadcasts to all subscribed WebSocket clients immediately
    4. Browser receives the update over its open WebSocket

---

## Tag Selector

1. Each device shows its configured metrics tags from the `device-config` shadow
2. Use the UI to add `net_io_bytes_sent` to a device's `device-config` **desired** shadow `metrics` array
3. Observe the device pick up the delta and add the new metric to its telemetry stream

This demonstrates the desired/reported/delta pattern end-to-end: UI writes desired → IoT Core computes delta → Device Client receives delta → handler script acts → device updates reported.

---

## References

- [AppSync Events HTTP publish](https://docs.aws.amazon.com/appsync/latest/eventapi/publish-http.html)
- [AppSync Events concepts](https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-concepts.html)
