/** Prevent predictable development accounts from ever being seeded in production. */
export function assertDevelopmentSeedAllowed(nodeEnv = process.env.NODE_ENV): void {
  if ((nodeEnv ?? '').trim().toLowerCase() === 'production') {
    throw new Error('Development seed cannot run in production');
  }
}
