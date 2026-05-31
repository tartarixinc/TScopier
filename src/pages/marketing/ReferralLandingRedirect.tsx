import { Navigate, useParams } from 'react-router-dom'
import { normalizeReferralCode, referralCodeLooksValid } from '../../lib/referralCapture'

export function ReferralLandingRedirect() {
  const { referralCode = '' } = useParams()
  const normalized = normalizeReferralCode(referralCode)

  if (!referralCodeLooksValid(normalized)) {
    return <Navigate to="/" replace />
  }

  return <Navigate to={`/?ref=${encodeURIComponent(normalized)}`} replace />
}

