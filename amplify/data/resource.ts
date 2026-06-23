import { type ClientSchema, a, defineData } from '@aws-amplify/backend';

const schema = a.schema({
  // AppSync requires at least one Query type in any schema. Without a @model,
  // Amplify Gen 2 won't auto-generate one, so we add a no-op health check query.
  healthCheck: a
    .query()
    .returns(a.string())
    .handler(a.handler.custom({ entry: './healthCheck.js' }))
    .authorization((allow) => [allow.authenticated()]),

  TelemetryEvent: a.customType({
    thingName: a.string().required(),
    messageTimestamp: a.float().required(),
    cpuPct: a.float(),
    memUsedPct: a.float(),
    diskUsedPct: a.float(),
    netIoByteSent: a.integer(),
    netIoByteRecv: a.integer(),
    deploymentId: a.string(),
  }),

  publishTelemetry: a
    .mutation()
    .arguments({
      thingName: a.string().required(),
      messageTimestamp: a.float().required(),
      cpuPct: a.float(),
      memUsedPct: a.float(),
      diskUsedPct: a.float(),
      netIoByteSent: a.integer(),
      netIoByteRecv: a.integer(),
      deploymentId: a.string(),
    })
    .returns(a.ref('TelemetryEvent'))
    .handler(a.handler.custom({ entry: './publishTelemetry.js' }))
    .authorization((allow) => [allow.authenticated()]),

  onTelemetry: a
    .subscription()
    .for(a.ref('publishTelemetry'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.custom({ entry: './onTelemetrySubscription.js' })),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'identityPool',
  },
});
