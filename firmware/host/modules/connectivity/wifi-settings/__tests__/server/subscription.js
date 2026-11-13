// Match the production module's default auth object and named call factory.
export function createSubscription() {
  throw new Error('Conversation is not used by the Settings fixture')
}

export default {
  status: () => ({ state: 'signed-out', signedIn: false, volatile: false }),
}
