# Block 4 — Fleet Indexing Introduction

**Duration:** 45 min

---

## Steps

1. Navigate to [**IoT Core → Settings → Fleet indexing → Manage indexing**](https://console.aws.amazon.com/iot/home#/settings)
2. Enable Thing indexing and select the following data sources:
    - **Add thing connectivity** — indexes connected/disconnected state, disconnect reason, and last connection timestamp
    - **Include socket information** *(new)* — indexes source IP, source port, target IP, target port, and VPC endpoint ID per connection
    - **Add named shadows** — add `device-config` and `device-health`
    - **Add device software packages and versions** — indexes the reserved `$package` shadow for version-targeted queries
3. Click **Update** and wait for index status to show `ACTIVE`.

    ??? example "AWS CLI equivalent"
        ```bash
        aws iot update-indexing-configuration \
          --thing-indexing-configuration \
            'thingIndexingMode=REGISTRY_AND_SHADOW,thingConnectivityIndexingMode=STATUS,namedShadowIndexingMode=ON,filter={namedShadowNames=["device-config","device-health","app-deployment","$package"]}'
        echo "UPDATE_OK"
        ```
        <!-- e2e:assert {"contains": "UPDATE_OK"} -->

        This mirrors the account-wide config the platform stack already applies on
        deploy (including the `app-deployment` shadow added in Session 3) — re-running
        it here is idempotent and safe against a live shared slot. It requires
        `iot:UpdateIndexingConfiguration` on your own account — a locked-down CI
        role without that permission will fail this step even though a workshop
        participant's own account will not.

    Check status:

    ```bash
    aws iot describe-index --index-name AWS_Things
    ```
    <!-- e2e:assert {"jsonPath": "indexStatus", "matches": "ACTIVE"} -->

4. Navigate to [**IoT Core → Manage → Things → Advanced thing search**](https://us-east-1.console.aws.amazon.com/iot/home?region=us-east-1#/search?indexType=AWS_Things&search=%22thingName%3A%20*%22) and confirm all devices are visible.

   > **Console tip:** The regular Things search bar uses a display-name dialect that doesn't support shadow/connectivity queries. Use **Advanced thing search** instead — it accepts the same Lucene syntax as the CLI and the links below pre-populate the query for you.

5. Scope to your deployment — filter by the `deploymentId` attribute so subsequent queries only return your three devices:

    [Open in console](https://us-east-1.console.aws.amazon.com/iot/home?region=us-east-1#/search?indexType=AWS_Things&search=attributes.deploymentId%3Aws-slot00){ .md-button target=_blank }

    ??? example "AWS CLI equivalent"
        ```bash
        aws iot search-index --index-name AWS_Things \
          --query-string 'attributes.deploymentId:ws-slot00'
        ```
        <!-- e2e:assert {"jsonPath": "things[0].thingName", "matches": ".+"} -->

    > **Note:** Thing names are EC2 instance IDs, not slot-prefixed — `attributes.deploymentId` is the right field to scope to your slot. Combine it with any other filter using `AND`, e.g. `attributes.deploymentId:ws-slot00 AND connectivity.connected:true`.

6. Query by shadow state — print the reported `config_version` (from the
   `device-config` shadow) and `telemetry-agent` version (from the reserved
   `$package` shadow) for each device, side by side:

    ```bash
    aws iot search-index --index-name AWS_Things \
      --query-string 'attributes.deploymentId:ws-slot00' \
    | jq -r '["THING","CONFIG_VERSION","TELEMETRY_AGENT"],
             (.things[] | [
               .thingName,
               (.shadow | fromjson | .name["device-config"].reported.config_version),
               (.shadow | fromjson | .name["$package"].reported["telemetry-agent"].version)
             ]) | @tsv' | column -t
    ```
    <!-- e2e:assert {"contains": "TELEMETRY_AGENT"} -->

    Output — one row per device:

    ```
    THING                CONFIG_VERSION  TELEMETRY_AGENT
    i-012cb542a8cd2ad6b  4.0.0           4.0.0
    i-0a661fd3a5c46da02  4.0.0           4.0.0
    i-0233f0350a555411c  4.0.0           4.0.0
    ```

    > **Note:** Fleet-indexing search is a *filter*, not a *projection* — a Lucene
    > query like `config_version:*` only decides which Things match; it can't make
    > the search *return* a field value. Both versions ride along inside each
    > matched Thing's shadow document, so we pull them out with `jq` client-side.
    > In the console you'd instead open a single Thing → **Device Shadows** and read
    > the `device-config` and `$package` shadows one at a time. To do a yes/no
    > rollout check on the fleet instead, add the version to the query itself, e.g.
    > `... AND shadow.name.device-config.reported.config_version:3.0.0`.

7. Query connectivity status:

    [Open in console](https://us-east-1.console.aws.amazon.com/iot/home?region=us-east-1#/search?indexType=AWS_Things&search=attributes.deploymentId%3Aws-slot00%20AND%20connectivity.connected%3Atrue){ .md-button target=_blank }

    ??? example "AWS CLI equivalent"
        ```bash
        aws iot search-index --index-name AWS_Things \
          --query-string 'attributes.deploymentId:ws-slot00 AND connectivity.connected:true'
        ```
        <!-- e2e:assert {"jsonPath": "things[0].thingName", "matches": ".+"} -->


---

## Discussion Questions

- What is the difference between a static Thing Group and a Dynamic Thing Group?
- How would you target a job at "all devices still on `telemetry-agent` v1.0.0"? (Hint: use the reserved `$package` shadow as the Dynamic Thing Group filter — `attributes.deploymentId:ws-slot00 AND shadow.name.$package.reported.telemetry-agent.version:1.0.0`.)
- What's the eventual-consistency caveat with Dynamic Thing Groups? (Group membership evaluates asynchronously — newly registered devices may take seconds to appear.)
- What does socket indexing let you do that plain connectivity indexing doesn't? (Answer: pinpoint which source IPs/ports are connecting — useful for diagnosing NAT traversal issues or spotting devices connecting from unexpected networks.)

---

## Wrap-Up

Recap the full Session 1 data path:

```
EC2 (IoT Device Client)
  → MQTT publish → IoT Core
  → IoT Rules Engine → Kafka action → MSK
  → Amazon Data Firehose (Iceberg destination) → S3
  → Athena (Glue catalog)
```

**Preview Session 2:** Next week you'll use IoT Jobs to push a script update to all 3 devices simultaneously — changing telemetry frequency from 0.2 Hz to 1 Hz and adding network I/O metrics.

---

## Reference

- [IoT Fleet Indexing](https://docs.aws.amazon.com/iot/latest/developerguide/iot-indexing.html)
- [Managing fleet indexing](https://docs.aws.amazon.com/iot/latest/developerguide/managing-fleet-index.html)
- [Dynamic Thing Groups](https://docs.aws.amazon.com/iot/latest/developerguide/dynamic-thing-groups.html)
- [Fleet indexing with Software Package Catalog](https://docs.aws.amazon.com/iot/latest/developerguide/preparing-fleet-indexing.html)
- [Example thing queries](https://docs.aws.amazon.com/iot/latest/developerguide/example-queries.html)
