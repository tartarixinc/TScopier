import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CircleCheck as CheckCircle, MessageCircle, Radio } from 'lucide-react'
import clsx from 'clsx'
import { TelegramLinkStep } from './steps/TelegramLinkStep'
import { ChannelSelectStep } from './steps/ChannelSelectStep'

const steps = [
  { id: 1, label: 'Telegram', icon: MessageCircle },
  { id: 2, label: 'Channels', icon: Radio },
]

export function OnboardingPage() {
  const navigate = useNavigate()
  const [currentStep, setCurrentStep] = useState(1)
  const [sessionId, setSessionId] = useState<string | null>(null)

  const handleTelegramDone = (sid: string) => {
    setSessionId(sid)
    setCurrentStep(2)
  }

  const handleChannelsDone = () => {
    navigate('/dashboard')
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-950 via-primary-900 to-primary-800 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <h1 className="text-white font-semibold text-2xl">Set up TScopier</h1>
          <p className="text-white/60 text-sm mt-1">
            Link Telegram and choose signal channels. Instructions are parsed with your channel keywords — no external broker API.
          </p>
        </div>

        <div className="flex items-center justify-center mb-8">
          {steps.map((step, idx) => {
            const done = currentStep > step.id
            const active = currentStep === step.id
            const Icon = step.icon

            return (
              <div key={step.id} className="flex items-center">
                <div className="flex flex-col items-center gap-1.5">
                  <div className={clsx(
                    'w-10 h-10 rounded-full flex items-center justify-center transition-all',
                    done ? 'bg-teal-500' : active ? 'bg-white dark:bg-neutral-900' : 'bg-white dark:bg-neutral-900/10'
                  )}>
                    {done
                      ? <CheckCircle className="w-5 h-5 text-white" />
                      : <Icon className={clsx('w-5 h-5', active ? 'text-primary-700' : 'text-white/40')} />
                    }
                  </div>
                  <span className={clsx(
                    'text-xs font-medium',
                    active ? 'text-white' : done ? 'text-primary-400' : 'text-white/40'
                  )}>
                    {step.label}
                  </span>
                </div>
                {idx < steps.length - 1 && (
                  <div className={clsx(
                    'w-20 h-px mx-2 mb-5 transition-colors',
                    currentStep > step.id ? 'bg-teal-500' : 'bg-white dark:bg-neutral-900/10'
                  )} />
                )}
              </div>
            )
          })}
        </div>

        <div className="animate-slide-up">
          {currentStep === 1 && <TelegramLinkStep onDone={handleTelegramDone} />}
          {currentStep === 2 && (
            <ChannelSelectStep
              sessionId={sessionId}
              onDone={handleChannelsDone}
            />
          )}
        </div>
      </div>
    </div>
  )
}
