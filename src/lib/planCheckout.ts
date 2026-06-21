export async function startPlanCheckout(params: {
  accessToken: string
  plan: 'basic' | 'advanced'
  interval: 'monthly' | 'annual'
  extraAccounts?: number
  successUrl?: string
  cancelUrl?: string
}): Promise<string> {
  const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-checkout-session`
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      plan: params.plan,
      interval: params.interval,
      extraAccounts: params.plan === 'advanced' ? (params.extraAccounts ?? 0) : 0,
      successUrl: params.successUrl ?? `${window.location.origin}/dashboard?checkout=success`,
      cancelUrl: params.cancelUrl ?? `${window.location.origin}/pricing`,
    }),
  })
  const data = (await res.json()) as { url?: string; error?: string }
  if (!res.ok || !data.url) {
    throw new Error(data.error || 'Checkout failed')
  }
  return data.url
}
