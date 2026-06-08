import { NextRequest, NextResponse } from "next/server";
import {
  IoTClient,
  ListThingsInThingGroupCommand,
  DescribeThingCommand,
} from "@aws-sdk/client-iot";
import {
  IoTDataPlaneClient,
  GetThingShadowCommand,
} from "@aws-sdk/client-iot-data-plane";

const iot = new IoTClient({ region: process.env.AWS_REGION ?? "us-east-1" });
const iotData = new IoTDataPlaneClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint: process.env.IOT_DATA_ENDPOINT,
});

export async function GET(req: NextRequest) {
  const deploymentId = req.nextUrl.searchParams.get("deployment") ?? "";
  if (!deploymentId) {
    return NextResponse.json({ error: "deployment param required" }, { status: 400 });
  }

  const groupName = `ws-${deploymentId}`;
  let thingNames: string[] = [];

  try {
    const resp = await iot.send(
      new ListThingsInThingGroupCommand({ thingGroupName: groupName })
    );
    thingNames = resp.things ?? [];
  } catch {
    return NextResponse.json({ error: `Thing group ${groupName} not found` }, { status: 404 });
  }

  const devices = await Promise.all(
    thingNames.map(async (thingName) => {
      const shadows: Record<string, unknown> = {};
      for (const shadowName of ["device-config", "device-health"]) {
        try {
          const r = await iotData.send(
            new GetThingShadowCommand({ thingName, shadowName })
          );
          if (r.payload) {
            const parsed = JSON.parse(Buffer.from(r.payload).toString("utf-8"));
            shadows[shadowName === "device-config" ? "deviceConfig" : "deviceHealth"] =
              parsed?.state?.reported ?? {};
          }
        } catch {
          // shadow may not exist yet
        }
      }

      return { thingName, ...shadows };
    })
  );

  return NextResponse.json({ devices });
}
