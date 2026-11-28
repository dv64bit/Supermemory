// supermem: analytics removed. Kept as a no-op so existing call sites stay unchanged.
export async function trackEvent(
	_eventName: string,
	_properties?: Record<string, unknown>,
): Promise<void> {}
