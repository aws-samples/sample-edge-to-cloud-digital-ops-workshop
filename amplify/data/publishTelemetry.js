// NONE datasource resolver — passes mutation arguments through without persisting.
// AppSync fires any subscriptions on this mutation after this returns.
export function request(ctx) {
  return { payload: ctx.arguments };
}

export function response(ctx) {
  return ctx.result;
}
