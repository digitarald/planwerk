export interface LeaseRenewalState {
  failure?: unknown;
}

/**
 * Run one synchronous lease renewal tick without allowing a timer exception to
 * escape to the process. The first failure wins and cancels the owned work.
 */
export function runLeaseRenewalTick(
  state: LeaseRenewalState,
  renew: () => boolean,
  cancel: (failure: unknown) => void,
  lostMessage: string,
): void {
  if (state.failure !== undefined) return;
  let failure: unknown;
  try {
    if (renew()) return;
    failure = new Error(lostMessage);
  } catch (error) {
    failure = error;
  }
  state.failure = failure;
  try {
    cancel(failure);
  } catch (cancelError) {
    console.warn(
      "[lease-renewal] Failed to cancel operation after lease loss:",
      cancelError instanceof Error ? cancelError.message : cancelError,
    );
  }
}
