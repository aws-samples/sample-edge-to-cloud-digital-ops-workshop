// Subscription resolver — just returns the mutation result to all subscribers.
export function request(ctx) {
  return { payload: null };
}

export function response(ctx) {
  return ctx.result;
}
