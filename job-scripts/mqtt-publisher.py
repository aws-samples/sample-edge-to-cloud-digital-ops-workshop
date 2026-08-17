#!/usr/bin/env python3
# --8<-- [start:mqtt-publisher]
"""Persistent MQTT-over-WebSockets telemetry publisher (#244).

Installed once at instance boot (amplify/custom/participant-stack.ts) and left
running for the life of the box. Replaces the per-message `aws iot-data
publish` CLI call (a brand-new Python process + fresh TLS handshake for every
message, measured at ~820ms p50 device->ingest) with ONE long-lived MQTT
connection: opens it once, then publishes each newline-delimited JSON payload
read from stdin over that same connection.

Authenticates via SigV4 websockets using the default AWS credential chain
(the EC2 instance role) -- the same `iot:Connect`/`iot:Publish` IAM policy
that already authorizes the old `aws iot-data publish` CLI call, so no
device certificate/key material is needed for this connection.

The bash publish loop (job-scripts/publish-telemetry.sh /
job-scripts/telemetry-v2.sh) collects metrics and builds each JSON payload as
before; this process only owns the MQTT connection and the publish call.
"""
import argparse
import sys

from awscrt import auth, mqtt
from awsiot import mqtt_connection_builder


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True, help="IoT Core data-plane ATS endpoint (no scheme)")
    parser.add_argument("--region", required=True)
    parser.add_argument("--topic", required=True)
    parser.add_argument("--client-id", required=True, help="Must differ from the device's own Thing/Jobs client id")
    args = parser.parse_args()

    credentials_provider = auth.AwsCredentialsProvider.new_default_chain()
    mqtt_connection = mqtt_connection_builder.websockets_with_default_aws_signing(
        endpoint=args.endpoint,
        region=args.region,
        credentials_provider=credentials_provider,
        client_id=args.client_id,
        clean_session=True,
        keep_alive_secs=30,
    )
    mqtt_connection.connect().result()

    try:
        for line in sys.stdin:
            payload = line.strip()
            if not payload:
                continue
            mqtt_connection.publish(topic=args.topic, payload=payload, qos=mqtt.QoS.AT_MOST_ONCE)
    finally:
        mqtt_connection.disconnect().result()

    return 0


if __name__ == "__main__":
    sys.exit(main())
# --8<-- [end:mqtt-publisher]
