import { NextRequest, NextResponse } from "next/server";
import {
  IoTDataPlaneClient,
  UpdateThingShadowCommand,
} from "@aws-sdk/client-iot-data-plane";

const iotData = new IoTDataPlaneClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint: process.env.IOT_DATA_ENDPOINT,
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { thingName, shadowName, desired } = body as {
    thingName: string;
    shadowName: string;
    desired: Record<string, unknown>;
  };

  if (!thingName || !shadowName || !desired) {
    return NextResponse.json({ error: "thingName, shadowName, desired required" }, { status: 400 });
  }

  const payload = JSON.stringify({ state: { desired } });

  await iotData.send(
    new UpdateThingShadowCommand({
      thingName,
      shadowName,
      payload: Buffer.from(payload),
    })
  );

  return NextResponse.json({ ok: true });
}
